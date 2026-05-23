import { type JobContext } from '@livekit/agents';
import { SipClient, TwirpError } from 'livekit-server-sdk';
import { env } from '../../config/env';
import { setFallbackActive } from '../../services/firestore';

interface SipDispatchInput {
  ctx: JobContext;
  phoneNumber: string;
  roomName: string;
  userId: string;
}

// Creates the outbound SIP participant and waits for it to join the room.
// On any failure (trunk reject, no answer, etc.), flips the user's ritual
// into fallback_active=true and shuts the job down. Returns true if the
// participant joined; false if the caller should stop (already shut down).
export async function placeSipCallOrShutdown({
  ctx,
  phoneNumber,
  roomName,
  userId,
}: SipDispatchInput): Promise<boolean> {
  const sipClient = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

  try {
    const participant = await sipClient.createSipParticipant(
      env.SIP_OUTBOUND_TRUNK_ID,
      phoneNumber,
      roomName,
      {
        participantIdentity: phoneNumber,
        participantName: `Test Caller: ${phoneNumber}`,
        krispEnabled: true,
        waitUntilAnswered: true,
      },
    );
    console.log('Participant created:', participant.participantIdentity);
  } catch (error) {
    if (error instanceof TwirpError) {
      console.error(`Twirp error creating SIP participant: ${error.code} - ${error.message}`);
    } else {
      console.error('Unknown error creating SIP participant:', error);
    }
  }

  try {
    await ctx.waitForParticipant(phoneNumber);
    return true;
  } catch {
    await setFallbackActive('sip_connection_failed', userId, true);
    ctx.shutdown();
    return false;
  }
}
