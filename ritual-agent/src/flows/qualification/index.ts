import { type JobContext, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { makeLlm, makeStt, makeTts } from '../../config/providers';
import { QUALIFICATION_VOICE_ID_BY_LANGUAGE } from '../../config/voiceIds';
import { type QualificationMeta } from '../../types/metadata';
import { IntakeAgent } from './intake';

// Lifecycle:
//   1. Worker accepts a dispatch with metadata { flow: 'qualification',
//      language, persona }.
//   2. We connect to the room, build the shared AgentSession, and start
//      with the IntakeAgent.
//   3. IntakeAgent runs the gates + safety, then calls gateDecision.
//   4. gateDecision either hands off to CaptureAgent (qualified path) or
//      submits + publishes outcome (DQ / safety paths).
//   5. CaptureAgent (qualified path) captures P2 verbatim, calls
//      submitQualification, publishes outcome, ends.
export async function runQualificationFlow(
  ctx: JobContext,
  meta: QualificationMeta,
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
    llm: makeLlm(),
    tts: makeTts(meta.language, voiceId),
    turnDetection: new livekit.turnDetector.MultilingualModel(),
    vad: ctx.proc.userData.vad! as silero.VAD,
  });

  // Lifecycle state — tracked across the Intake → Capture handoff.
  // (userTurnCount is declared further down in the watchdog block so the
  // watchdog can use it as a gate.)
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
  const FILLER_TEXT = meta.language === 'es' ? 'Mmm.' : 'Hmm.';
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (ev.newState === 'thinking') {
      thinkingTimer = setTimeout(() => {
        thinkingTimer = null;
        try { session.say(FILLER_TEXT, { addToChatCtx: false }); } catch { /* ignore */ }
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
  const POOR_AUDIO_EXIT_THRESHOLD = 0.80;  // avg above this → clear flag
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
          console.log('[qualification audio-quality] entering poorAudio', { avg });
          // Don't interrupt here — the user just spoke and the LLM is about
          // to auto-reply. Let the next turn (or the watchdog) handle the
          // mic-check. The poorAudio flag will steer both.
        } else if (
          poorAudioActive &&
          avg > POOR_AUDIO_EXIT_THRESHOLD
        ) {
          poorAudioActive = false;
          console.log('[qualification audio-quality] exiting poorAudio', { avg });
        }
      }
    }
  });

  // Sniff outcome events published by the tools so the shutdown log knows
  // why the call ended. (The same events are consumed by the frontend.)
  ctx.room.on('dataReceived', (payload, participant) => {
    if (participant?.identity !== ctx.room.localParticipant?.identity) return;
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload)) as {
        type?: string;
        outcome?: string;
      };
      if (
        msg.type === 'qualification:outcome' &&
        (msg.outcome === 'qualified' ||
          msg.outcome === 'disqualified')
      ) {
        outcome = msg.outcome;
      }
    } catch {
      // ignore non-JSON
    }
  });

  ctx.addShutdownCallback(async () => {
    clearWatchdog();
    console.log('[qualification flow lifecycle]', {
      userTurnCount,
      outcome,
      language: meta.language,
      finalAvgConfidence: avgConfidence(),
      poorAudioActiveAtEnd: poorAudioActive,
    });
  });

  await session.start({
    agent: new IntakeAgent(meta, ctx),
    room: ctx.room,
    inputOptions: {
      // Web (WebRTC) flow — keep the LiveKit Cloud noise cancellation default.
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });
}
