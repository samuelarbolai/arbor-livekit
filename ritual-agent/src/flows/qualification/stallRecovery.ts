import { voice } from '@livekit/agents';

// Recovers the agent when a generation produces no speech, so the caller is
// never stranded in silence.
//
// Why this exists: gemini-2.5-flash periodically returns an empty completion
// (finishReason STOP, zero output tokens) on this flow's sensitive content. The
// google plugin treats that as retryable and the core LLM loop retries to
// exhaustion, then fails the turn with no spoken output. The session itself
// survives (it tolerates up to maxUnrecoverableErrors before closing), so the
// agent just goes quiet — observed as 40+ seconds of dead air until the caller
// hangs up. safetySettings (see providers.ts) reduce how often this happens;
// this is the net that guarantees we recover when it still does.
//
// Two detectors feed one recovery:
//   - llm_error: react to the session Error event, debounced so the plugin's
//     retry burst collapses into a single recovery once it has truly given up.
//   - stall: a backstop timer for a generation that hangs without ever
//     surfacing an error (the watchdog in index.ts only covers user silence).
// Recovery itself (onRecover) is the caller's job — typically session.say() of a
// short re-prompt, which both breaks the silence and resets the session's
// unrecoverable-error counter (it resets whenever the agent speaks).

export type StallRecoveryReason = 'llm_error' | 'stall';

export type StallRecoveryOptions = {
  /** Debounce after the last error before recovering. Waits out the retry burst. */
  errorGraceMs?: number;
  /** Max time stuck outside listening/speaking before forcing recovery. */
  stallMs?: number;
  /** Minimum gap between recoveries, so a persistent failure can't machine-gun. */
  refractoryMs?: number;
  onRecover: (reason: StallRecoveryReason) => void;
};

export function attachStallRecovery(
  session: voice.AgentSession,
  opts: StallRecoveryOptions,
): () => void {
  const errorGraceMs = opts.errorGraceMs ?? 3_000;
  const stallMs = opts.stallMs ?? 12_000;
  const refractoryMs = opts.refractoryMs ?? 8_000;

  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRecoverAt = 0;
  let disposed = false;

  const clearErrorTimer = () => {
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  };
  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const recover = (reason: StallRecoveryReason) => {
    if (disposed) return;
    const now = Date.now();
    if (now - lastRecoverAt < refractoryMs) return;
    lastRecoverAt = now;
    clearErrorTimer();
    clearStallTimer();
    opts.onRecover(reason);
  };

  // We react to any session Error (in practice these are LLM errors here; STT/TTS
  // errors are also worth a re-prompt). The state guard + refractory keep this
  // from firing spuriously.
  const onError = () => {
    clearErrorTimer();
    errorTimer = setTimeout(() => {
      errorTimer = null;
      recover('llm_error');
    }, errorGraceMs);
  };

  const onAgentStateChanged = (ev: voice.AgentStateChangedEvent) => {
    if (ev.newState === 'speaking' || ev.newState === 'listening') {
      // Healthy: producing speech or waiting on the user. Cancel pending work.
      clearErrorTimer();
      clearStallTimer();
      return;
    }
    // Stuck in thinking/generating → arm the backstop.
    clearStallTimer();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      recover('stall');
    }, stallMs);
  };

  session.on(voice.AgentSessionEventTypes.Error, onError);
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);

  return () => {
    disposed = true;
    clearErrorTimer();
    clearStallTimer();
    session.off(voice.AgentSessionEventTypes.Error, onError);
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
  };
}
