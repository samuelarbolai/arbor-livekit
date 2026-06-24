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
import { type DemoCallMeta } from '../../types/metadata';
import { attachIdleShutdown } from '../onboarding/idleHandler';
import { attachStallRecovery } from '../qualification/stallRecovery';
import { DemoCallAgent } from './agent';
import { publishSnapshot, publishVariableUpdate, publishVisual, type StoryStage } from './broadcast';
import {
  CALL_STATE_SENTINEL,
  CURRENT_PHASE_SENTINEL,
  INITIAL_DEMO_PHASE,
  buildCallStateRecap,
  buildCurrentPhaseBlock,
  buildDemoCallPrompt,
} from './prompts/demo-call-prompt';
import {
  DEFAULT_FIT_STATE,
  DEMO_VOICE_ID_BY_LANGUAGE,
  DERIVED_PREFILLS,
  QUALIFICATION_SAME_NAME_FIELDS,
  USER_VISIBLE_NAMES,
} from './variables';

// The unified demo-persistence CF (transcript mode). Also used by the migrated
// /copilot Save button (rep-state mode). Unset → submission is skipped (logged).
const EXTRACT_DEMO_CALL_URL = process.env.EXTRACT_DEMO_CALL_URL;

const LOAD_QUALIFICATION_URL = 'https://loadqualification-b6fhjlgejq-uc.a.run.app';

// Web-flow caps. The Demo Call runs ~70 min, so the hard cap is 80 min — do
// NOT copy qualification's 25-min cap, which would kill the call mid-way. Idle
// stays at the canonical 10 min (resets on any conversation item).
const HARD_MAX_SESSION_MS = 80 * 60 * 1000;

// Hydrate the prospect's Fit Assessment data into the demo state. Same-name
// fields copy 1:1; DERIVED_PREFILLS map a qualify field onto a differently-
// named demo variable. Graceful: any failure → empty prefill (Phase 1.5 thins
// out — the call still runs).
async function loadQualificationPrefill(email: string): Promise<Record<string, string>> {
  if (!email) return {};
  try {
    const res = await fetch(LOAD_QUALIFICATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      ok: boolean;
      qualification?: Record<string, unknown>;
    };
    if (!data.ok || !data.qualification) return {};
    const q = data.qualification;
    const out: Record<string, string> = {};
    for (const f of QUALIFICATION_SAME_NAME_FIELDS) {
      const v = q[f];
      if (typeof v === 'string' && v.trim()) out[f] = v;
    }
    for (const { from, to } of DERIVED_PREFILLS) {
      const v = q[from];
      if (typeof v === 'string' && v.trim() && !out[to]) out[to] = v;
    }
    return out;
  } catch (err) {
    console.warn('[demo-call] loadQualification failed', err);
    return {};
  }
}

export async function runDemoCallFlow(ctx: JobContext, meta: DemoCallMeta): Promise<void> {
  await ctx.connect();

  // ── Pre-call setup (worker-side, no LLM, no per-turn latency) ──────────────
  // Design C: the agent's brain is the authored prompt (no live Doc load). The
  // only per-call input is the prospect's Fit Assessment prefill, which seeds
  // the <call-so-far> memory the agent reflects in Phase 1.5 and never re-asks.
  const prefill = await loadQualificationPrefill(meta.prospect_email);
  const state: Record<string, string> = {
    prospect_name: meta.prospect_name,
    ...prefill,
    fit_state: prefill.fit_state ?? DEFAULT_FIT_STATE,
  };

  const instructions = buildDemoCallPrompt(meta.language, meta.prospect_name);
  // The agent refreshes this each turn (see DemoCallAgent.onUserTurnCompleted),
  // so it always reflects the latest captured state.
  const getCallStateRecap = (): string => buildCallStateRecap(state);

  let currentPhase: string = INITIAL_DEMO_PHASE;
  const getCurrentPhaseBlock = (): string => buildCurrentPhaseBlock(currentPhase);

  const initialCtx = agentsLlm.ChatContext.empty();
  initialCtx.addMessage({
    role: 'system',
    content: `${CURRENT_PHASE_SENTINEL}\n${getCurrentPhaseBlock()}`,
  });
  initialCtx.addMessage({
    role: 'system',
    content: `${CALL_STATE_SENTINEL}\n${getCallStateRecap()}`,
  });

  const voiceId = DEMO_VOICE_ID_BY_LANGUAGE[meta.language];

  // preemptiveGeneration EXPLICITLY false — WebRTC mic conditions are
  // unpredictable; preemptive-on leaks cancelled-TTS fragments on unstable
  // interims. SDK default is true, so omitting ≠ off.
  const session = new voice.AgentSession({
    stt: makeStt(meta.language),
    // Clinical content + a 70-min call → reuse the qualification LLM stack:
    // gemini-2.5-flash (thinkingBudget:0) with the OpenAI FallbackAdapter for
    // empty completions, BLOCK_NONE so sensitive content isn't soft-blocked.
    llm: makeQualificationLlm(UNFILTERED_SAFETY_SETTINGS),
    tts: makeTts(meta.language, voiceId),
    turnDetection: new livekit.turnDetector.MultilingualModel(),
    vad: ctx.proc.userData.vad! as silero.VAD,
    preemptiveGeneration: false,
  });

  // ── Lifecycle state ────────────────────────────────────────────────────────
  let submitted = false;
  let userTurnCount = 0;
  // Full transcript, accumulated worker-side for the end-of-call extractor. The
  // agent's own working context is truncated for long calls (see #6), so we keep
  // the complete record here independently.
  const fullTranscript: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // ── Verbal filler on long thinking turns ────────────────────────────────────
  const FILLER_THRESHOLD_MS = 4_000;
  const FILLER_TEXT = meta.language === 'es' ? 'Mmm.' : 'Hmm.';
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

  // ── Audio-quality + idle watchdog (ported from qualification) ───────────────
  const CONFIDENCE_WINDOW_SIZE = 3;
  const POOR_AUDIO_ENTER_THRESHOLD = 0.65;
  const POOR_AUDIO_EXIT_THRESHOLD = 0.8;
  const IDLE_WATCHDOG_MS = 8_000;
  const IDLE_WATCHDOG_REFRACTORY_MS = 30_000;
  const recentConfidences: number[] = [];
  let poorAudioActive = false;
  let lastUserAudioAt = Date.now();
  let lastWatchdogFireAt = 0;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  function avgConfidence(): number {
    if (recentConfidences.length === 0) return 1;
    return recentConfidences.reduce((a, b) => a + b, 0) / recentConfidences.length;
  }
  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }
  function scheduleWatchdog() {
    clearWatchdog();
    if (userTurnCount < 1) return; // infinite patience on the opener
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      const now = Date.now();
      if (now - lastWatchdogFireAt < IDLE_WATCHDOG_REFRACTORY_MS) return;
      if (
        session.agentState !== 'listening' ||
        session.userState === 'speaking' ||
        now - lastUserAudioAt < IDLE_WATCHDOG_MS
      ) {
        scheduleWatchdog();
        return;
      }
      lastWatchdogFireAt = now;
      const instructions =
        meta.language === 'es'
          ? poorAudioActive
            ? 'El usuario lleva ~8 s sin audio transcribible y la calidad reciente fue baja. Interrumpe con calidez: dile honestamente que no lo estás escuchando bien y pídele una prueba breve de micrófono ("¿podrías acercarte al micrófono y decirme tu nombre completo?"). UNA sola frase.'
            : 'El usuario lleva ~8 s en silencio. Haz UN check-in cálido y muy corto ("¿sigues conmigo?"). UNA sola frase.'
          : poorAudioActive
            ? 'The user has been silent ~8 s and recent transcripts were low-confidence. Warmly say you\'re having trouble hearing them and ask for a short mic test. ONE sentence.'
            : 'The user has been silent ~8 s. Make ONE warm, very short check-in. ONE sentence.';
      try {
        session.generateReply({ instructions, allowInterruptions: true });
      } catch {
        /* race with shutdown */
      }
    }, IDLE_WATCHDOG_MS);
  }
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, () => {
    lastUserAudioAt = Date.now();
    scheduleWatchdog();
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    if (ev.newState === 'speaking') {
      lastUserAudioAt = Date.now();
      scheduleWatchdog();
    }
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (ev.newState === 'listening') {
      lastUserAudioAt = Date.now();
      scheduleWatchdog();
    } else {
      clearWatchdog();
    }
  });

  // ── Empty-completion / stall recovery ───────────────────────────────────────
  const RECOVERY_TEXT =
    meta.language === 'es'
      ? 'Perdona, se me cruzó la línea un momento. ¿Me lo repites, por favor?'
      : 'Sorry, my line glitched for a second — could you say that again?';
  const disposeStallRecovery = attachStallRecovery(session, {
    onRecover: (reason) => {
      console.warn('[demo-call] recovering from stalled generation', { reason });
      try {
        session.say(RECOVERY_TEXT, { addToChatCtx: false });
      } catch {
        /* race with shutdown */
      }
    },
  });
  ctx.addShutdownCallback(async () => {
    disposeStallRecovery();
  });

  // Accumulate the full transcript (user + assistant) for the extractor, and
  // track user turns + audio confidence.
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type !== 'message') return;
    const role = ev.item.role;
    if (role !== 'user' && role !== 'assistant') return;
    const content = ev.item.textContent;
    if (content) fullTranscript.push({ role, content });
    if (role !== 'user') return;
    userTurnCount++;
    const conf = ev.item.transcriptConfidence;
    if (typeof conf !== 'number') return;
    recentConfidences.push(conf);
    if (recentConfidences.length > CONFIDENCE_WINDOW_SIZE) recentConfidences.shift();
    const avg = avgConfidence();
    if (
      !poorAudioActive &&
      recentConfidences.length >= CONFIDENCE_WINDOW_SIZE &&
      avg < POOR_AUDIO_ENTER_THRESHOLD
    ) {
      poorAudioActive = true;
      console.log('[demo-call audio-quality] entering poorAudio', { avg });
    } else if (poorAudioActive && avg > POOR_AUDIO_EXIT_THRESHOLD) {
      poorAudioActive = false;
      console.log('[demo-call audio-quality] exiting poorAudio', { avg });
    }
  });

  // ── Converse → extract submission ───────────────────────────────────────────
  async function submitIfNotYet(
    reason: 'endCall' | 'disconnect' | 'idle_timeout' | 'hard_cap',
  ): Promise<void> {
    if (submitted) return;
    submitted = true;
    console.log('[demo-call] submitting', {
      reason,
      transcriptTurns: fullTranscript.length,
      userTurnCount,
      fit_state: state.fit_state,
    });
    if (!EXTRACT_DEMO_CALL_URL) {
      console.warn('[demo-call] EXTRACT_DEMO_CALL_URL not set — skipping submission');
      return;
    }
    try {
      const resp = await fetch(EXTRACT_DEMO_CALL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'transcript',
          transcript: fullTranscript,
          liveState: state,
          prospect_name: meta.prospect_name,
          prospect_email: meta.prospect_email,
          language: meta.language,
        }),
      });
      if (!resp.ok) {
        console.error('[demo-call] extractDemoCall non-OK', { status: resp.status });
      }
    } catch (err) {
      console.error('[demo-call] submission failed', err);
    }
  }

  // ── Tool callbacks (the only inbound path from the agent) ───────────────────
  const callbacks = {
    onUpdatePhase: (phase: string): void => {
      console.log('[demo-call] phase →', { from: currentPhase, to: phase });
      currentPhase = phase;
    },
    onSetVars: async (updates: Array<{ name: string; value: string }>): Promise<string[]> => {
      const committed: string[] = [];
      for (const { name, value } of updates) {
        if (typeof value !== 'string' || value.trim().length === 0) continue;
        state[name] = value;
        committed.push(name);
        if (USER_VISIBLE_NAMES.has(name)) publishVariableUpdate(ctx.room, name, value);
      }
      // No context rebuild here — the agent refreshes <call-so-far> from `state`
      // on its next turn (onUserTurnCompleted), so captures land in memory then.
      return committed;
    },
    onShowVisual: (stage: StoryStage): void => {
      publishVisual(ctx.room, stage);
    },
    onEndCall: (): void => {
      submitIfNotYet('endCall')
        .catch((err) => console.error('[demo-call] endCall submission error', err))
        .finally(() => setTimeout(() => ctx.shutdown('endCall'), 2_000));
    },
  };

  // Disconnect-flush.
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === ctx.room.localParticipant?.identity) return;
    console.log('[demo-call] participant disconnected', { identity: participant.identity });
    submitIfNotYet('disconnect').catch((err) =>
      console.error('[demo-call] disconnect submission error', err),
    );
  });

  // Re-emit prefilled user-visible notes when the prospect (re)joins, so the
  // panel isn't empty before the agent edits anything.
  ctx.room.on(RoomEvent.ParticipantConnected, () => {
    publishSnapshot(ctx.room, state, USER_VISIBLE_NAMES);
  });

  ctx.addShutdownCallback(async () => {
    clearWatchdog();
    console.log('[demo-call flow lifecycle]', {
      userTurnCount,
      fit_state: state.fit_state,
      outcome: state.outcome ?? '',
      language: meta.language,
      poorAudioActiveAtEnd: poorAudioActive,
    });
  });

  const agent = new DemoCallAgent(meta, ctx, instructions, initialCtx, callbacks, getCallStateRecap, getCurrentPhaseBlock);

  attachIdleShutdown(ctx, session); // 10-min idle → ctx.shutdown('idle_timeout')

  const hardCapTimer = setTimeout(() => {
    console.warn('[demo-call] hard session cap reached, forcing shutdown', {
      durationMs: HARD_MAX_SESSION_MS,
      userTurnCount,
      submitted,
    });
    submitIfNotYet('hard_cap')
      .catch((err) => console.error('[demo-call] hard_cap submission error', err))
      .finally(() => setTimeout(() => ctx.shutdown('hard_cap'), 3_000));
  }, HARD_MAX_SESSION_MS);
  ctx.addShutdownCallback(async () => {
    clearTimeout(hardCapTimer);
  });

  await session.start({
    agent,
    room: ctx.room,
    inputOptions: {
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });

  // Prospect is typically already in the room (they joined, then we were
  // dispatched) — push the prefilled notes now too.
  publishSnapshot(ctx.room, state, USER_VISIBLE_NAMES);
}
