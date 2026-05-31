import { ServerOptions, llm as agentsLlm, cli, defineAgent, voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { RoomEvent } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { SipClient, TwirpError } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';
import {
  Agent,
  type RitualEntry,
  type TrackingState,
  buildTrackingCallbackBody,
  freshKpiBundle,
} from './agent';

dotenv.config({ path: '.env.local' });

type Language = 'en' | 'es';

// Hardcoded Cartesia voiceIDs per language (2026-05-06 user choice). The
// tracking-agent intentionally ignores `metadata.voice_id` — voice for
// tracking calls is a brand decision, not a per-user preference. ritual-agent's
// flows/call (the morning-coaching call) still consumes the user's voiceID; the
// two agents have different roles and intentionally use different voices.
const VOICE_ID_BY_LANGUAGE: Record<Language, string> = {
  en: '5ee9feff-1265-424a-9d7f-8e4d431a12c7', // English-Male
  es: 'b042270c-d46f-4d4f-8fb0-7dd7c5fe5615', // Spanish-Male
};

interface DispatchMetadata {
  user_id: string;
  phone_number: string;
  language: string;
  room_name: string;
  run_id: string;
  tracking_callback_url: string;
  rituals: RitualEntry[];
}

interface ProcessUserData {
  vad: silero.VAD;
}

// URL of the extractTrackingKpis cloud function. Set on LiveKit Cloud as
// a worker secret and in .env.local for local dev. Falls back to skipping
// extraction if unset — the no-conversation path (userTurnCount === 0)
// still works without it.
const EXTRACT_TRACKING_KPIS_URL = process.env.EXTRACT_TRACKING_KPIS_URL;

// Verbal filler. If the LLM stays in `thinking` for more than the
// threshold, inject a soft conversational acknowledgment so the user
// doesn't sit in silence on long Gemini turns. addToChatCtx: false keeps
// it out of the model's own context so it never sees the filler as part
// of the transcript. Pattern lifted from ritual-agent's flows/qualification.
const FILLER_THRESHOLD_MS = 4_000;
const FILLER_TEXT_BY_LANGUAGE: Record<Language, string> = {
  en: 'Hmm.',
  es: 'Mmm.',
};

// Idle handler. A tracking call should never sit silent for very long.
// 5 min is generous for a 1–3 min check-in and stops SIP minutes from
// leaking when the user has walked away mid-call without hanging up.
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

// Hard wall-clock cap. Belt-and-suspenders to the idle handler — that
// resets on ANY ConversationItemAdded, which an open mic in a noisy
// environment will keep tripping with low-confidence ambient
// transcripts. Per samwise-livekit-agents skill: every flow needs a
// hard cap because LiveKit Cloud bills per active room minute. 15 min
// is well past any legitimate tracking call (real ones land in 1–3 min).
const HARD_MAX_SESSION_MS = 15 * 60 * 1000;

// Build marker. BUMP on every deploy — logged per job so the worker logs name the
// exact build that served a given call (rollout lags the build; `lk agent status`
// only shows deploy time, not which build handled a specific call). See the
// samwise-livekit-agents skill, "Confirming which build served a session".
const BUILD_TAG = '2026-05-31-buildtag-openai-fallback';

export default defineAgent<ProcessUserData>({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    console.log(`[tracking-agent] build=${BUILD_TAG} job=${ctx.job.id}`);
    const LIVEKIT_URL = process.env.LIVEKIT_URL!;
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
    const SIP_OUTBOUND_TRUNK_ID = process.env.SIP_OUTBOUND_TRUNK_ID!;

    const metadata = (
      ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {}
    ) as Partial<DispatchMetadata>;
    const userID = metadata.user_id ?? 'unknown_user';
    const phoneNumber = metadata.phone_number ?? '';
    // Cast to Language for the deepgram/cartesia plugins which accept a
    // narrow union. Defaults to 'en' if metadata didn't include one.
    const language = ((metadata.language as Language) ?? 'en') as Language;
    const voiceId = VOICE_ID_BY_LANGUAGE[language];
    const roomName = metadata.room_name ?? ctx.room.name ?? '';
    const runId = metadata.run_id ?? '';
    const trackingCallbackUrl = metadata.tracking_callback_url;
    const rituals: RitualEntry[] = metadata.rituals ?? [];

    if (metadata.rituals !== undefined && rituals.length === 0) {
      console.error('Dispatch metadata.rituals is empty; aborting session.');
      ctx.shutdown();
      return;
    }

    let userTurnCount = 0;
    let submitted = false;
    let agent: Agent | null = null;

    // Convert the agent's chat history into a transcript the extractor
    // can consume. Only user + assistant text messages — skip the system
    // prompt and any tool-call / tool-result entries. Mirrors the
    // qualification flow's buildTranscript exactly.
    function buildTranscript(
      chatCtx: agentsLlm.ChatContext,
    ): Array<{ role: 'user' | 'assistant'; content: string }> {
      const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const item of chatCtx.items) {
        if (item.type !== 'message') continue;
        if (item.role !== 'user' && item.role !== 'assistant') continue;
        const content = item.textContent;
        if (!content) continue;
        turns.push({ role: item.role, content });
      }
      return turns;
    }

    // The fresh-bundle state used both as the no-conversation fallback
    // and as the defensive shape if extraction is somehow unavailable.
    function freshState(): TrackingState {
      return Object.fromEntries(rituals.map((r) => [r.googleDocId, freshKpiBundle()]));
    }

    async function postToCallback(
      conversationHappened: boolean,
      state: TrackingState,
    ): Promise<void> {
      if (!trackingCallbackUrl) return;
      try {
        await fetch(trackingCallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildTrackingCallbackBody({
              userID,
              runId,
              conversationHappened,
              state,
            }),
          ),
        });
      } catch (err) {
        console.error('trackingCallback POST failed', err);
      }
    }

    // Single submission path. Four triggers converge here: agent calls
    // endCall, SIP participant disconnects, idle handler fires, hard
    // wall-clock cap fires. Idempotent on `submitted`.
    async function submitIfNotYet(
      reason: 'endCall' | 'disconnect' | 'idle_timeout' | 'hard_cap',
    ): Promise<void> {
      if (submitted) return;
      submitted = true;

      // No conversation happened (user never answered, hangup before
      // first turn, etc.) — short-circuit to fresh bundles. The
      // workflow uses conversationHappened=false to fall through to
      // the SMS path.
      if (userTurnCount === 0 || !agent) {
        console.log('[tracking] submitting (no conversation)', {
          reason,
          userTurnCount,
          agentReady: !!agent,
        });
        await postToCallback(false, freshState());
        return;
      }

      const transcript = buildTranscript(agent.chatCtx);
      console.log('[tracking] submitting', {
        reason,
        transcriptTurns: transcript.length,
        userTurnCount,
        ritualCount: rituals.length,
      });

      // No extractor URL configured — submit fresh bundles flagged as
      // conversationHappened so the workflow doesn't fall back to SMS
      // (a conversation DID happen), but with null KPIs. Operations
      // can fill in manually from the call recording if this state
      // ever ships.
      if (!EXTRACT_TRACKING_KPIS_URL) {
        console.warn('[tracking] EXTRACT_TRACKING_KPIS_URL not set — submitting fresh bundles');
        await postToCallback(true, freshState());
        return;
      }

      try {
        const resp = await fetch(EXTRACT_TRACKING_KPIS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript,
            language,
            rituals: rituals.map((r) => ({
              googleDocId: r.googleDocId,
              name: r.behaviorLabel ?? r.label,
            })),
          }),
        });
        if (!resp.ok) {
          console.error('[tracking] extractTrackingKpis returned non-OK', {
            status: resp.status,
            statusText: resp.statusText,
          });
          await postToCallback(true, freshState());
          return;
        }
        const data = (await resp.json()) as {
          ok: boolean;
          ritualKpis: TrackingState;
        };
        await postToCallback(true, data.ritualKpis);
      } catch (err) {
        console.error('[tracking] extraction submission failed', err);
        await postToCallback(true, freshState());
      }
    }

    // Registered before any SIP/session setup so the submission still
    // fires on early-exit paths (SIP connect failure, prewarm crash,
    // etc). When no conversation happened the submitIfNotYet branch
    // above short-circuits to fresh bundles.
    ctx.addShutdownCallback(async () => {
      await submitIfNotYet('disconnect');
    });

    await ctx.connect();

    if (phoneNumber) {
      const sipClient = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      try {
        await sipClient.createSipParticipant(SIP_OUTBOUND_TRUNK_ID, phoneNumber, roomName, {
          participantIdentity: phoneNumber,
          participantName: `Tracking Caller: ${phoneNumber}`,
          krispEnabled: true,
          waitUntilAnswered: true,
        });
      } catch (err) {
        if (err instanceof TwirpError) {
          console.error(`SIP error: ${err.code} - ${err.message}`);
        } else {
          console.error('Unknown error creating SIP participant:', err);
        }
        ctx.shutdown();
        return;
      }

      try {
        await ctx.waitForParticipant(phoneNumber);
      } catch (err) {
        console.error('SIP participant never connected:', err);
        ctx.shutdown();
        return;
      }
    }

    // Voice pipeline: same provider stack as narya-agent
    // (Deepgram STT + Google Gemini LLM + Cartesia TTS).
    const session = new voice.AgentSession({
      stt: new deepgram.STT({
        model: 'nova-3',
        language,
      }),
      // Gemini primary, OpenAI fallback for the empty-completion bug:
      // gemini-2.5-flash intermittently returns finishReason STOP with zero output
      // tokens; the plugin retries to exhaustion → dead air. On an empty Gemini
      // turn the adapter switches to OpenAI, preserving chat context + the (single,
      // no-arg) endCall tool. Mirrors ritual-agent's makeQualificationLlm.
      // REQUIRES OPENAI_API_KEY in the deployed secrets (lk agent update-secrets)
      // and in .env.local for `pnpm dev`; without it the fallback path errors only
      // when it fires (no worse than today's empty-completion dead air). tracking's
      // sole tool is endCall (no args), so the cross-provider `.nullish` tool-arg
      // issue does not apply here.
      llm: new agentsLlm.FallbackAdapter({
        llms: [
          new google.LLM({
            // Pinned to gemini-2.5-flash; see AGENT_MODEL comment in agent.ts
            // for why the 3-preview model is unsafe with the current plugin.
            model: 'gemini-2.5-flash',
            // thinkingBudget: 0 — tracking is a narrow KPI capture, no CoT
            // needed; saves latency. includeThoughts: false is defensive
            // against Google flipping the default and leaking English
            // thought summaries into the TTS stream (observed 2026-05-27).
            thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
          }),
          new openai.LLM({ model: 'gpt-4o-mini' }),
        ],
        maxRetryPerLLM: 3,
      }),
      tts: new cartesia.TTS({
        model: 'sonic-3',
        voice: voiceId,
        language,
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad,
      // Telephony flow — preemptiveGeneration stays ON. The skill's rule
      // is: ON for phone (mostly monologue, controlled audio); OFF for
      // web flows with user-supplied mic. SDK 2026 surface: voiceOptions
      // was flattened onto AgentSessionOptions and `preemptiveGeneration`
      // moved under turnHandling.
      turnHandling: {
        preemptiveGeneration: { enabled: true },
      },
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      // ev.item is `ChatMessage | AgentHandoffItem`; only the former has a role.
      if ('role' in ev.item && ev.item.role === 'user') userTurnCount++;
    });

    // Thinking filler — soft "Hmm." / "Mmm." when the LLM hangs in
    // `thinking` past FILLER_THRESHOLD_MS so the user doesn't sit in
    // dead air.
    const fillerText = FILLER_TEXT_BY_LANGUAGE[language];
    let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState === 'thinking') {
        thinkingTimer = setTimeout(() => {
          thinkingTimer = null;
          try {
            session.say(fillerText, { addToChatCtx: false });
          } catch {
            /* ignore — race with shutdown */
          }
        }, FILLER_THRESHOLD_MS);
      } else if (thinkingTimer) {
        clearTimeout(thinkingTimer);
        thinkingTimer = null;
      }
    });

    // Idle shutdown — resets on any ConversationItemAdded. If neither
    // side has produced an event in IDLE_SHUTDOWN_MS, end the call so
    // billing stops.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(`[tracking] idle for ${IDLE_SHUTDOWN_MS}ms, shutting down`);
        ctx.shutdown('idle_timeout');
      }, IDLE_SHUTDOWN_MS);
    };
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, resetIdle);
    resetIdle();
    ctx.addShutdownCallback(async () => {
      if (idleTimer) clearTimeout(idleTimer);
    });

    // Hard wall-clock cap. Routes through submitIfNotYet so if the
    // model never called endCall, extraction still runs over whatever
    // transcript we have.
    const hardCapTimer = setTimeout(() => {
      console.warn('[tracking] hard session cap reached, forcing shutdown', {
        durationMs: HARD_MAX_SESSION_MS,
        userTurnCount,
        submitted,
      });
      submitIfNotYet('hard_cap')
        .catch((err) => console.error('[tracking] hard_cap submission error', err))
        .finally(() => {
          ctx.shutdown('hard_cap');
        });
    }, HARD_MAX_SESSION_MS);
    ctx.addShutdownCallback(async () => {
      clearTimeout(hardCapTimer);
    });

    // SIP hangup → submit. The phone participant's identity is
    // `phoneNumber` (see createSipParticipant above). Ignore the
    // agent's own (local) disconnect.
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === ctx.room.localParticipant?.identity) return;
      console.log('[tracking] participant disconnected', {
        identity: participant.identity,
      });
      submitIfNotYet('disconnect').catch((err) => {
        console.error('[tracking] disconnect submission error', err);
      });
    });

    agent = new Agent({
      language,
      rituals,
      callbacks: {
        onEndCall: () => {
          submitIfNotYet('endCall').catch((err) => {
            console.error('[tracking] endCall submission error', err);
          });
        },
      },
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        // LiveKit Cloud enhanced noise cancellation. For telephony you can
        // swap to `BackgroundVoiceCancellationTelephony` if voice quality
        // suffers, but mirroring narya's setup for now.
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'tracking-agent',
  }),
);
