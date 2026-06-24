import { type JobContext, llm as agentsLlm, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { RoomEvent } from '@livekit/rtc-node';
import {
  UNFILTERED_SAFETY_SETTINGS,
  makeQualificationLlm,
  makeStt,
  makeTts,
} from '../../config/providers';
import { QUALIFICATION_VOICE_ID_BY_LANGUAGE } from '../../config/voiceIds';
import { type QualificationTherapistMeta } from '../../types/metadata';
import { attachIdleShutdown } from '../onboarding/idleHandler';
import { attachStallRecovery } from '../qualification/stallRecovery';
import { TherapistQualificationAgent } from './agent';

const EXTRACT_QUALIFICATION_THERAPIST_URL =
  process.env.EXTRACT_QUALIFICATION_THERAPIST_URL;

// Lifecycle (single-agent + agent/scribe split):
//   1. Worker accepts a dispatch with metadata { flow: 'qualification-therapist',
//      language, prospect_name, prospect_email? }.
//   2. We connect to the room, build the AgentSession, and start the
//      TherapistQualificationAgent (one agent for the entire call, one prompt,
//      two tools: setVariables + endCall).
//   3. The agent has a thoughtful interview, committing user-verbatim
//      notes via setVariables. Each setVariables call publishes a
//      `qualification:variable_update` data event so the frontend's
//      <VariablesPanel> fills live.
//   4. Submission triggers — whichever fires first wins:
//       (a) the agent calls endCall (natural close after its closing line);
//       (b) the user disconnects from the room;
//       (c) the idle handler hits IDLE_MS with no activity.
//      All three route through submitIfNotYet(), which is idempotent on
//      a per-call `submitted` flag.
//   5. submitIfNotYet POSTs the transcript to the extractQualificationTherapist
//      cloud function. The CF runs an extraction LLM over the transcript
//      to produce the authoritative therapist payload, writes the
//      qualifications/{prospectKey} doc, and (for the therapist flow)
//      always returns outcome: 'qualified' — no gate.
//   6. The CF's response carries { outcome, prospectKey, docId }. The
//      worker publishes a `qualification:outcome` data event so the
//      frontend swaps to <FinalScreen>. The frontend then disconnects.
export async function runQualificationTherapistFlow(
  ctx: JobContext,
  meta: QualificationTherapistMeta,
): Promise<void> {
  await ctx.connect();

  const voiceId = QUALIFICATION_VOICE_ID_BY_LANGUAGE[meta.language];

  // preemptiveGeneration is intentionally OFF for qualification. The flow runs
  // over WebRTC with unpredictable user mic conditions; with bad audio Deepgram
  // delivers many unstable interim transcripts per turn, each of which would
  // spawn a parallel LLM call + Cartesia synthesis with preemptive on. The
  // cancellations leak as "Invalid transcript: No valid transcripts passed"
  // errors and audible fragments ("Es", "La forma en que los...") when a
  // canceled TTS leaks its first frames before being cut. The ~300–600 ms of
  // latency we trade is acceptable for an intake conversation where being
  // understood matters more than reacting fast.
  const session = new voice.AgentSession({
    stt: makeStt(meta.language),
    llm: makeQualificationLlm(UNFILTERED_SAFETY_SETTINGS),
    tts: makeTts(meta.language, voiceId),
    turnDetection: new livekit.turnDetector.MultilingualModel(),
    vad: ctx.proc.userData.vad! as silero.VAD,
    // EXPLICITLY false — load-bearing. AgentSessionOptions defaults
    // preemptiveGeneration to TRUE in @livekit/agents 1.2.0, so OMITTING this field
    // does NOT yield "off": until 2026-05-31 this flow was silently running with it
    // ON, exactly the fragment-leak behavior the comment above warns against. The
    // top-level field is the correct surface (the deprecated `voiceOptions` wrapper
    // is flattened onto AgentSessionOptions).
    preemptiveGeneration: false,
  });

  // Lifecycle state — tracked across the whole call. (userTurnCount is
  // declared further down in the watchdog block so the watchdog can use
  // it as a gate.)
  let outcome: 'qualified' | 'disqualified' | 'abandoned' = 'abandoned';

  // Verbal filler. If the LLM stays in `thinking` for more than the threshold,
  // inject a soft conversational acknowledgment so the user doesn't sit in
  // silence on long responses. addToChatCtx: false keeps it out of the model's
  // own context so it never sees the filler as part of the transcript.
  //
  // Tradeoffs we accept:
  //  - Race risk: if the LLM finishes while the filler is rendering, LiveKit's
  //    TTS pipeline may overlap or clip. We accept this for now; iterate if
  //    real calls show issues.
  //  - First-turn behavior: the filler can fire during onEnter's initial
  //    generateReply if startup is slow. "Mmm. Hi, I'm Nova..." reads as a
  //    natural warm-up rather than a bug — left intentional.
  const FILLER_THRESHOLD_MS = 4_000;
  const FILLER_TEXT = meta.language === 'es' ? 'Dame un momento por favor.' : 'Just a second, please.';
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (ev.newState === 'thinking') {
      thinkingTimer = setTimeout(() => {
        thinkingTimer = null;
        try {
          session.say(FILLER_TEXT, { addToChatCtx: false });
        } catch {
          /* ignore */
        }
      }, FILLER_THRESHOLD_MS);
    } else if (thinkingTimer) {
      clearTimeout(thinkingTimer);
      thinkingTimer = null;
    }
  });

  // ─── Audio-quality watchers ────────────────────────────────────────────────
  // Two related concerns the qualification flow has shown in production:
  //
  //  (1) Bad mic / fragmented STT → Deepgram returns low-confidence
  //      transcripts that the LLM tries to respond to verbatim, producing
  //      circular "what do you mean by X?" loops. We detect this from the
  //      rolling avg of transcriptConfidence on final user messages, and
  //      proactively interrupt to ask for a mic check ONCE per "bad audio
  //      episode" (with hysteresis to avoid flapping).
  //
  //  (2) Turn detector colgado → the user keeps emitting audio that STT
  //      can't parse (or short fragments separated by silence the turn
  //      detector won't commit), the LLM never fires, the agent appears
  //      to hang for 30 s – 3 min. The idle watchdog fires when BOTH
  //      sides have been quiet for IDLE_WATCHDOG_MS, asking a warm
  //      check-in. Quiet on the user side means "no transcript event of
  //      any kind, partial or final, has arrived."
  //
  // Both watchers gate on lifecycle: nothing fires before the agent has
  // spoken its first turn (the opener), and the watchdog won't re-fire
  // within IDLE_WATCHDOG_REFRACTORY_MS of its last fire to avoid pestering.

  const CONFIDENCE_WINDOW_SIZE = 3;
  const POOR_AUDIO_ENTER_THRESHOLD = 0.65; // avg below this → flag bad audio
  const POOR_AUDIO_EXIT_THRESHOLD = 0.8; // avg above this → clear flag
  const IDLE_WATCHDOG_MS = 8_000;
  const IDLE_WATCHDOG_REFRACTORY_MS = 30_000;

  const recentConfidences: number[] = [];
  let poorAudioActive = false;
  let lastUserAudioAt = Date.now();
  let lastWatchdogFireAt = 0;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let userTurnCount = 0; // moved up here so the watchdog can read it

  function avgConfidence(): number {
    if (recentConfidences.length === 0) return 1;
    const sum = recentConfidences.reduce((a, b) => a + b, 0);
    return sum / recentConfidences.length;
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function scheduleWatchdog() {
    clearWatchdog();
    // Gate #1 — infinite patience on the opener. We don't fire the watchdog
    // until the user has produced at least one full turn. The opener may
    // arrive while the user is still putting on headphones / unmuting / etc.
    if (userTurnCount < 1) return;
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      const now = Date.now();

      // Burn the refractory window on EVERY attempt, including the bailouts
      // below. Otherwise a fire that bails on "user is still speaking" can
      // re-trigger 1 s later when state changes and produce duplicates.
      const sinceLastFire = now - lastWatchdogFireAt;
      if (sinceLastFire < IDLE_WATCHDOG_REFRACTORY_MS) return;

      // Re-verify before firing.
      //  - Agent must actually be in listening (not speaking/thinking/initializing).
      //  - User must be silent on the transcript side (no events in >= IDLE_WATCHDOG_MS).
      //  - Gate #2 — VAD must agree the user is not currently speaking. This
      //    catches long monologues where transcripts arrive sparsely; the user
      //    is talking but Deepgram batches partials in 15–25 s chunks.
      if (
        session.agentState !== 'listening' ||
        session.userState === 'speaking' ||
        now - lastUserAudioAt < IDLE_WATCHDOG_MS
      ) {
        // Reschedule and try again later. Do NOT update lastWatchdogFireAt —
        // we didn't actually fire.
        scheduleWatchdog();
        return;
      }
      lastWatchdogFireAt = now;
      const instructions =
        meta.language === 'es'
          ? poorAudioActive
            ? 'El usuario lleva ~8 s sin emitir audio que se pueda transcribir y la calidad de las últimas transcripciones ha sido baja. Interrumpe con calidez: dile honestamente que no lo estás escuchando bien y pídele una prueba breve de mic — algo como "¿podrías acercarte al micrófono y decirme tu nombre completo? Quiero asegurarme de oírte bien". UNA sola frase, sin acumular preguntas.'
            : 'El usuario lleva ~8 s en silencio. Haz UN check-in cálido y muy corto ("¿sigues ahí, [nombre]?"). UNA sola frase.'
          : poorAudioActive
            ? 'The user has been silent for ~8 s and recent transcripts have been low-confidence. Interrupt warmly: tell them honestly you\'re having trouble hearing them and ask for a short mic test — something like "Could you move closer to the mic and say your full name? I want to make sure I\'m hearing you." ONE sentence only, no stacked questions.'
            : 'The user has been silent for ~8 s. Make ONE warm, very short check-in ("Are you still there, [name]?"). ONE sentence only.';
      try {
        session.generateReply({ instructions, allowInterruptions: true });
      } catch {
        /* ignore — race with shutdown */
      }
    }, IDLE_WATCHDOG_MS);
  }

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, () => {
    // Any transcript activity (partial or final) means audio is flowing.
    // Reset both the silence timer and the watchdog.
    lastUserAudioAt = Date.now();
    scheduleWatchdog();
  });

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    // VAD-level signal. While the user is actively speaking we treat that
    // as a heartbeat too, even before Deepgram has committed a partial —
    // this is what prevents the watchdog from firing mid-monologue.
    if (ev.newState === 'speaking') {
      lastUserAudioAt = Date.now();
      scheduleWatchdog();
    }
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    // Schedule/cancel watchdog around agent's own speaking. We only count
    // post-speaking silence — during the agent's own speech or thinking,
    // the user is naturally listening.
    if (ev.newState === 'listening') {
      lastUserAudioAt = Date.now(); // reset baseline at the moment of handoff
      scheduleWatchdog();
    } else {
      clearWatchdog();
    }
  });

  // ─── Empty-completion / stall recovery ─────────────────────────────────────
  // gemini-2.5-flash occasionally returns an empty completion on this flow's
  // sensitive content; the google plugin retries it to exhaustion and the turn
  // fails with no speech, leaving the caller in silence (observed: 40+ s of dead
  // air until hangup). The UNFILTERED_SAFETY_SETTINGS above make this rare; this
  // is the net that recovers when it still happens. On a failed or stalled
  // generation we say a short re-prompt — which breaks the silence AND resets the
  // session's unrecoverable-error counter (it resets whenever the agent speaks),
  // so the session never accumulates its way to an error-close.
  const RECOVERY_TEXT =
    meta.language === 'es'
      ? 'Perdona, se me cruzó la línea un momento. ¿Me lo repites, por favor?'
      : 'Sorry, my line glitched for a second — could you say that again?';
  const disposeStallRecovery = attachStallRecovery(session, {
    onRecover: (reason) => {
      console.warn('[qualification-therapist] recovering from stalled generation', { reason });
      try {
        session.say(RECOVERY_TEXT, { addToChatCtx: false });
      } catch {
        /* race with shutdown — ignore */
      }
    },
  });
  ctx.addShutdownCallback(async () => {
    disposeStallRecovery();
  });

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type !== 'message') return;
    if (ev.item.role === 'user') {
      userTurnCount++;
      // Track confidence on FINAL user messages only (these are what the LLM
      // sees). transcriptConfidence is optional on ChatMessage — skip undefined.
      const conf = ev.item.transcriptConfidence;
      if (typeof conf === 'number') {
        recentConfidences.push(conf);
        if (recentConfidences.length > CONFIDENCE_WINDOW_SIZE) {
          recentConfidences.shift();
        }
        const avg = avgConfidence();
        if (
          !poorAudioActive &&
          recentConfidences.length >= CONFIDENCE_WINDOW_SIZE &&
          avg < POOR_AUDIO_ENTER_THRESHOLD
        ) {
          poorAudioActive = true;
          console.log('[qualification-therapist audio-quality] entering poorAudio', { avg });
          // Don't interrupt here — the user just spoke and the LLM is about
          // to auto-reply. Let the next turn (or the watchdog) handle the
          // mic-check. The poorAudio flag will steer both.
        } else if (poorAudioActive && avg > POOR_AUDIO_EXIT_THRESHOLD) {
          poorAudioActive = false;
          console.log('[qualification-therapist audio-quality] exiting poorAudio', { avg });
        }
      }
    }
  });

  // ─── Submission path ──────────────────────────────────────────────────────
  // The agent reference is captured in a local so submitIfNotYet can read
  // its chatCtx for the transcript. Assigned at session.start below.
  let agent: TherapistQualificationAgent | null = null;
  let submitted = false;

  // Convert the agent's chat history into a transcript the extraction
  // cloud function can consume. Only user + assistant text messages —
  // skip the system prompt and any tool-call / tool-result entries.
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

  async function submitIfNotYet(
    reason: 'endCall' | 'disconnect' | 'idle_timeout' | 'hard_cap',
  ): Promise<void> {
    if (submitted) return;
    submitted = true;

    if (!agent) {
      console.warn('[qualification-therapist] submitIfNotYet fired before agent ready', { reason });
      return;
    }

    const transcript = buildTranscript(agent.chatCtx);
    console.log('[qualification-therapist] submitting', {
      reason,
      transcriptTurns: transcript.length,
      userTurnCount,
    });

    // Tell the frontend extraction is in progress — it swaps the mic for
    // the "Almost there — pulling up your link." indicator and disables
    // PTT so the user doesn't talk into a closing call. Only fired on
    // the endCall path; on disconnect / idle_timeout / hard_cap the user
    // is already gone (or about to be) and there's nothing to render.
    if (reason === 'endCall') {
      try {
        await ctx.room.localParticipant?.publishData(
          new TextEncoder().encode(JSON.stringify({ type: 'qualification:finalizing' })),
          { reliable: true },
        );
      } catch (err) {
        console.warn('[qualification-therapist] finalizing publishData failed', err);
      }
    }

    if (!EXTRACT_QUALIFICATION_THERAPIST_URL) {
      console.warn(
        '[qualification-therapist] EXTRACT_QUALIFICATION_THERAPIST_URL not set — skipping submission',
      );
      return;
    }

    try {
      const resp = await fetch(EXTRACT_QUALIFICATION_THERAPIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          prospect_name: meta.prospect_name,
          prospect_email: meta.prospect_email,
          language: meta.language,
        }),
      });
      if (!resp.ok) {
        console.error('[qualification-therapist] extractQualificationTherapist returned non-OK', {
          status: resp.status,
          statusText: resp.statusText,
        });
        return;
      }
      const data = (await resp.json()) as {
        ok: boolean;
        outcome: 'qualified' | 'disqualified';
        docId: string;
        prospectKey: string;
      };
      outcome = data.outcome;

      // Publish the outcome so the landing swaps to <FinalScreen>. Skipped
      // on the disconnect path because the frontend is already gone — the
      // outcome lives in Firestore and the email goes out regardless.
      if (reason !== 'disconnect') {
        try {
          await ctx.room.localParticipant?.publishData(
            new TextEncoder().encode(
              JSON.stringify({ type: 'qualification:outcome', outcome: data.outcome }),
            ),
            { reliable: true },
          );
        } catch (err) {
          console.warn('[qualification-therapist] outcome publishData failed', err);
        }
      }
    } catch (err) {
      console.error('[qualification-therapist] submission failed', err);
      // Don't unset `submitted` — the call is already winding down; a retry
      // mid-shutdown would just race the worker exit. The CF is idempotent
      // on prospectKey so a future re-submission (e.g. cron retry) is safe.
    }
  }

  // Disconnect-flush: if the user closes the tab without the agent reaching
  // endCall, fire submission with whatever transcript we have. Ignore
  // disconnects of the local (agent) participant — only react to remote.
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === ctx.room.localParticipant?.identity) return;
    console.log('[qualification-therapist] participant disconnected', { identity: participant.identity });
    submitIfNotYet('disconnect').catch((err) => {
      console.error('[qualification-therapist] disconnect submission error', err);
    });
  });

  ctx.addShutdownCallback(async () => {
    clearWatchdog();
    console.log('[qualification-therapist flow lifecycle]', {
      userTurnCount,
      outcome,
      language: meta.language,
      finalAvgConfidence: avgConfidence(),
      poorAudioActiveAtEnd: poorAudioActive,
    });
  });

  agent = new TherapistQualificationAgent(meta, ctx, {
    onEndCall: () => {
      submitIfNotYet('endCall').catch((err) => {
        console.error('[qualification-therapist] endCall submission error', err);
      });
    },
  });

  // Hard idle shutdown (canonical per the samwise-livekit-agents skill —
  // web flows can sit forever without phone-call boundaries). 10 min of no
  // ConversationItemAdded events → ctx.shutdown('idle_timeout'). We do NOT
  // also fire submitIfNotYet here because the shutdown will cause
  // participantDisconnected, which already routes to submitIfNotYet.
  attachIdleShutdown(ctx, session);

  // Wall-clock hard cap on session duration. Belt-and-suspenders to the
  // idle handler above — that one resets on ANY ConversationItemAdded
  // event, which an open mic in a noisy room will keep tripping with
  // low-confidence ambient transcripts. Without an absolute cap, observed
  // sessions ran 196 minutes on the LiveKit dashboard (real cost).
  // 25 min is well past any legitimate qualify call (real ones land in
  // 8–15 min). When this fires we route through submitIfNotYet('hard_cap')
  // so the existing flow takes over: transcript is extracted, outcome is
  // computed, `qualification:outcome` data event is published to the
  // room, and the landing's <FinalScreen> swap kicks in — bringing the
  // user (if still present) to the booking CTA. We then `ctx.shutdown`
  // so the LiveKit room tears down promptly and billing stops.
  const HARD_MAX_SESSION_MS = 25 * 60 * 1000;
  const hardCapTimer = setTimeout(() => {
    console.warn('[qualification-therapist] hard session cap reached, forcing shutdown', {
      durationMs: HARD_MAX_SESSION_MS,
      userTurnCount,
      submitted,
    });
    submitIfNotYet('hard_cap')
      .catch((err) => console.error('[qualification-therapist] hard_cap submission error', err))
      .finally(() => {
        // Give the outcome data event a moment to reach the browser so
        // <FinalScreen> swaps before the room tears down. Even on slow
        // links 3s is plenty for one reliable data message.
        setTimeout(() => ctx.shutdown('hard_cap'), 3_000);
      });
  }, HARD_MAX_SESSION_MS);
  ctx.addShutdownCallback(async () => {
    clearTimeout(hardCapTimer);
  });

  await session.start({
    agent,
    room: ctx.room,
    inputOptions: {
      // Web (WebRTC) flow — keep the LiveKit Cloud noise cancellation default.
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });
}
