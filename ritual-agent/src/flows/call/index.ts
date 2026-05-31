import { type JobContext, llm, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { makeLlm, makeStt, makeTts } from '../../config/providers';
import { type CallMeta } from '../../types/metadata';
import { Agent } from './agent';
import { attachIdleWatchdog } from './idleWatchdog';
import { attachCallShutdownPolicy } from './shutdownPolicy';
import { placeSipCallOrShutdown } from './sipDispatch';
import { attachThinkingFiller } from './thinkingFiller';

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
    // preemptiveGeneration ON — telephony latency win and the skill's prescribed
    // default for SIP/call flows (it's also AgentSessionOptions' own default in
    // @livekit/agents 1.2.0). Use the TOP-LEVEL field, NOT the deprecated
    // `voiceOptions` wrapper (flattened onto AgentSessionOptions; it moves under
    // `turnHandling.preemptiveGeneration.enabled` in 1.3.x — see tracking-agent).
    // It was briefly OFF (2026-05-30) as a leak mitigation, but the leak is fixed
    // at the source by thinkingBudget: 0 (qualification leaked with it OFF, proving
    // it was never the cause). See the skill, "preemptiveGeneration: per-flow tradeoff".
    preemptiveGeneration: true,
  });

  attachCallShutdownPolicy(ctx, session, meta.user_id);
  attachThinkingFiller(session, meta.language);
  attachIdleWatchdog(session, meta.language);

  // Hard wall-clock cap + idle shutdown. The idleWatchdog above only PROMPTS a
  // check-in ("¿sigues conmigo?") — it never ends the call — and shutdownPolicy
  // only runs ON shutdown. So without these, a connected-but-stuck call (voicemail
  // loop, call forwarding, an abandoned-but-noisy line whose ambient transcripts
  // keep the check-in resetting) runs unbounded, and LiveKit Cloud bills per active
  // room minute. Mirrors tracking-agent's phone-flow caps (5 min idle / 15 min
  // hard). The hard cap is the unconditional backstop; the idle timer exits faster
  // when nothing is happening at all. Both route through ctx.shutdown so the
  // existing shutdown policy (fallback flag by userTurnCount) still runs.
  const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
  const HARD_MAX_SESSION_MS = 15 * 60 * 1000;
  let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleShutdown = () => {
    if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
    idleShutdownTimer = setTimeout(() => {
      console.log(`[ritual-agent/call] idle ${IDLE_SHUTDOWN_MS}ms — shutting down`);
      ctx.shutdown();
    }, IDLE_SHUTDOWN_MS);
  };
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, resetIdleShutdown);
  resetIdleShutdown();
  const hardCapTimer = setTimeout(() => {
    console.warn(`[ritual-agent/call] hard cap ${HARD_MAX_SESSION_MS}ms — forcing shutdown`);
    ctx.shutdown();
  }, HARD_MAX_SESSION_MS);
  ctx.addShutdownCallback(async () => {
    if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
    clearTimeout(hardCapTimer);
  });

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
    agent: new Agent(initialCtx),
    room: ctx.room,
    inputOptions: {
      // LiveKit Cloud enhanced noise cancellation. For telephony, swap to
      // BackgroundVoiceCancellationTelephony if voice quality regresses.
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });
}
