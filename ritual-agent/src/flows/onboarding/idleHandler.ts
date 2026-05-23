import { type JobContext, voice } from '@livekit/agents';

const TEN_MINUTES_MS = 10 * 60 * 1000;

// Resets a timer on every conversation event. If no event fires within
// `idleMs`, calls ctx.shutdown() so LiveKit minutes stop accruing while
// the user is silent (e.g. they walked away mid-session).
export function attachIdleShutdown(
  ctx: JobContext,
  session: voice.AgentSession,
  idleMs: number = TEN_MINUTES_MS,
): void {
  let timer: NodeJS.Timeout | null = null;

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`onboarding: idle for ${idleMs}ms, shutting down`);
      ctx.shutdown('idle_timeout');
    }, idleMs);
  };

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, reset);

  ctx.addShutdownCallback(async () => {
    if (timer) clearTimeout(timer);
  });

  reset();
}
