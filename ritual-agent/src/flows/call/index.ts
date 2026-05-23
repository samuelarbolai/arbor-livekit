import { type JobContext, llm, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { makeLlm, makeStt, makeTts } from '../../config/providers';
import { type CallMeta } from '../../types/metadata';
import { Agent } from './agent';
import { placeSipCallOrShutdown } from './sipDispatch';
import { attachCallShutdownPolicy } from './shutdownPolicy';

const LANGUAGE_NAME: Record<CallMeta['language'], string> = {
  en: 'english',
  es: 'spanish',
};

export async function runCallFlow(ctx: JobContext, meta: CallMeta): Promise<void> {
  await ctx.connect();

  const joined = await placeSipCallOrShutdown({
    ctx,
    phoneNumber: meta.phone_number,
    roomName: meta.room_name,
    userId: meta.user_id,
  });
  if (!joined) return;

  const session = new voice.AgentSession({
    stt: makeStt(meta.language),
    llm: makeLlm(),
    tts: makeTts(meta.language, meta.voice_id),
    turnDetection: new livekit.turnDetector.MultilingualModel(),
    vad: ctx.proc.userData.vad! as silero.VAD,
    voiceOptions: {
      // Allow the LLM to generate a response while waiting for the end of turn
      preemptiveGeneration: true,
    },
  });

  const shutdownPolicy = attachCallShutdownPolicy(ctx, session, meta.user_id);

  const initialCtx = llm.ChatContext.empty();
  initialCtx.addMessage({
    role: 'system',
    content: `
      <user-inputs>
        ${meta.user_id}
        ${meta.user_input}
      </user-inputs>
      <language>
        You are a native ${LANGUAGE_NAME[meta.language]} speaker. Speak only in ${LANGUAGE_NAME[meta.language]}. The user is also a native ${LANGUAGE_NAME[meta.language]} speaker.
      </language>
      `,
  });

  await session.start({
    agent: new Agent(initialCtx, ctx, shutdownPolicy.setVoicemailDetected),
    room: ctx.room,
    inputOptions: {
      // LiveKit Cloud enhanced noise cancellation. For telephony, swap to
      // BackgroundVoiceCancellationTelephony if voice quality regresses.
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });
}
