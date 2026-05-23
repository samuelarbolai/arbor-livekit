import { type JobContext, voice } from '@livekit/agents';
import { setFallbackActive } from '../../services/firestore';

interface ShutdownPolicyHandle {
  // Mutable flag the Agent's leaveVoicemail tool flips when it detects voicemail.
  // Read at shutdown to decide which fallback reason to record.
  setVoicemailDetected: () => void;
}

// Wires the shutdown decision tree for the call flow:
//   - voicemail detected           -> fallback_active = true
//   - no user turns at all          -> fallback_active = true
//   - at least one user turn        -> fallback_active = false (the call worked)
export function attachCallShutdownPolicy(
  ctx: JobContext,
  session: voice.AgentSession,
  userId: string,
): ShutdownPolicyHandle {
  let userTurnCount = 0;
  let voicemailDetected = false;

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.role === 'user') userTurnCount++;
  });

  ctx.addShutdownCallback(async () => {
    if (voicemailDetected) {
      await setFallbackActive('voicemail_detected', userId, true);
    } else if (userTurnCount === 0) {
      await setFallbackActive('no_user_turns', userId, true);
    } else {
      await setFallbackActive('completed', userId, false);
    }
  });

  return { setVoicemailDetected: () => (voicemailDetected = true) };
}
