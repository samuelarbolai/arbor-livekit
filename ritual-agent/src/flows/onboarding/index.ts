import { type JobContext, llm, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { makeLlm, makeStt, makeTts } from '../../config/providers';
import { ONBOARDING_VOICE_ID_BY_LANGUAGE } from '../../config/voiceIds';
import { type OnboardingMeta } from '../../types/metadata';
import { OnboardingAgent } from './agent';
import { attachIdleShutdown } from './idleHandler';

const LANGUAGE_NAME: Record<OnboardingMeta['language'], string> = {
  en: 'english',
  es: 'spanish',
};

export async function runOnboardingFlow(
  ctx: JobContext,
  meta: OnboardingMeta,
): Promise<void> {
  await ctx.connect();

  const voiceId = ONBOARDING_VOICE_ID_BY_LANGUAGE[meta.language];

  const session = new voice.AgentSession({
    stt: makeStt(meta.language),
    llm: makeLlm(),
    tts: makeTts(meta.language, voiceId),
    turnDetection: new livekit.turnDetector.MultilingualModel(),
    vad: ctx.proc.userData.vad! as silero.VAD,
    voiceOptions: {
      preemptiveGeneration: true,
    },
  });

  attachIdleShutdown(ctx, session);

  const initialCtx = llm.ChatContext.empty();
  initialCtx.addMessage({
    role: 'system',
    content: `
      <ritual-id>${meta.ritual_id}</ritual-id>
      <google-doc-id>${meta.google_doc_id}</google-doc-id>
      <language>
        You are a native ${LANGUAGE_NAME[meta.language]} speaker. Speak only in ${LANGUAGE_NAME[meta.language]}. The user is also a native ${LANGUAGE_NAME[meta.language]} speaker.
      </language>
      <prior-session-context>
        These were captured BEFORE this Call Design Session. Treat them as known facts about the user — refer to them by name when the script calls for it. Do not re-elicit them.
        <helpers-list>${meta.helpers_list || '(none captured)'}</helpers-list>
        <core-motivation>${meta.core_motivation || '(none captured)'}</core-motivation>
        <daily-activity-to-face-reality>${meta.daily_activity_to_face_reality || '(none captured)'}</daily-activity-to-face-reality>
      </prior-session-context>
      `,
  });

  await session.start({
    agent: new OnboardingAgent(initialCtx, meta.google_doc_id),
    room: ctx.room,
    inputOptions: {
      // Web (WebRTC) flow — keep the LiveKit Cloud noise cancellation default.
      // (Telephony flows would swap to BackgroundVoiceCancellationTelephony.)
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });
}
