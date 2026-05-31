import { type JobContext, voice } from '@livekit/agents';
import { setFallbackActive } from '../../services/firestore';

// Wires the shutdown decision tree for the call flow:
//   - no user turns at all   -> fallback_active = true (no answer, voicemail,
//                                or call dropped before user spoke)
//   - at least one user turn -> fallback_active = false (the call worked)
export function attachCallShutdownPolicy(
  ctx: JobContext,
  session: voice.AgentSession,
  userId: string,
): void {
  let userTurnCount = 0;

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.role === 'user') userTurnCount++;
  });

  ctx.addShutdownCallback(async () => {
    if (userTurnCount === 0) {
      await setFallbackActive('no_user_turns', userId, true);
    } else {
      await setFallbackActive('completed', userId, false);
    }
  });
}
