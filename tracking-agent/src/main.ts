import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { SipClient, TwirpError } from 'livekit-server-sdk';
import {
  Agent,
  buildTrackingCallbackBody,
  freshKpiBundle,
  type RitualEntry,
  type TrackingState,
} from './agent';

dotenv.config({ path: '.env.local' });

type Language = 'en' | 'es';

// Hardcoded Cartesia voiceIDs per language (2026-05-06 user choice). The
// tracking-agent intentionally ignores `metadata.voice_id` — voice for
// tracking calls is a brand decision, not a per-user preference. Narya
// (the morning-coaching agent) still consumes the user's voiceID; the
// two agents have different roles and intentionally use different voices.
const VOICE_ID_BY_LANGUAGE: Record<Language, string> = {
  en: '5ee9feff-1265-424a-9d7f-8e4d431a12c7', // English-Male
  es: 'b042270c-d46f-4d4f-8fb0-7dd7c5fe5615', // Spanish-Male
};

interface DispatchMetadata {
  user_id: string;
  phone_number: string;
  language: string;
  room_name: string;
  run_id: string;
  tracking_callback_url: string;
  rituals: RitualEntry[];
}

interface ProcessUserData {
  vad: silero.VAD;
}

export default defineAgent<ProcessUserData>({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    const LIVEKIT_URL = process.env.LIVEKIT_URL!;
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
    const SIP_OUTBOUND_TRUNK_ID = process.env.SIP_OUTBOUND_TRUNK_ID!;

    const metadata = (ctx.job.metadata
      ? JSON.parse(ctx.job.metadata)
      : {}) as Partial<DispatchMetadata>;
    const userID = metadata.user_id ?? 'unknown_user';
    const phoneNumber = metadata.phone_number ?? '';
    // Cast to Language for the deepgram/cartesia plugins which accept a
    // narrow union. Defaults to 'en' if metadata didn't include one.
    const language = ((metadata.language as Language) ?? 'en') as Language;
    const voiceId = VOICE_ID_BY_LANGUAGE[language];
    const roomName = metadata.room_name ?? ctx.room.name ?? '';
    const runId = metadata.run_id ?? '';
    const trackingCallbackUrl = metadata.tracking_callback_url;
    const rituals: RitualEntry[] = metadata.rituals ?? [];

    if (metadata.rituals !== undefined && rituals.length === 0) {
      console.error('Dispatch metadata.rituals is empty; aborting session.');
      ctx.shutdown();
      return;
    }

    let userTurnCount = 0;
    const state: TrackingState = Object.fromEntries(
      rituals.map((r) => [r.googleDocId, freshKpiBundle()]),
    );

    // Registered before any SIP/session setup so it fires even on early-exit
    // failure paths (SIP connect failure, prewarm crash, etc). The workflow
    // treats userTurnCount=0 as "no conversation happened" and falls through
    // to the SMS path.
    ctx.addShutdownCallback(async () => {
      if (!trackingCallbackUrl) return;
      try {
        await fetch(trackingCallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildTrackingCallbackBody({
              userID,
              runId,
              conversationHappened: userTurnCount > 0,
              state,
            }),
          ),
        });
      } catch (err) {
        console.error('trackingCallback POST failed', err);
      }
    });

    await ctx.connect();

    if (phoneNumber) {
      const sipClient = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      try {
        await sipClient.createSipParticipant(
          SIP_OUTBOUND_TRUNK_ID,
          phoneNumber,
          roomName,
          {
            participantIdentity: phoneNumber,
            participantName: `Tracking Caller: ${phoneNumber}`,
            krispEnabled: true,
            waitUntilAnswered: true,
          },
        );
      } catch (err) {
        if (err instanceof TwirpError) {
          console.error(`SIP error: ${err.code} - ${err.message}`);
        } else {
          console.error('Unknown error creating SIP participant:', err);
        }
        ctx.shutdown();
        return;
      }

      try {
        await ctx.waitForParticipant(phoneNumber);
      } catch (err) {
        console.error('SIP participant never connected:', err);
        ctx.shutdown();
        return;
      }
    }

    // Voice pipeline: same provider stack as narya-agent
    // (Deepgram STT + Google Gemini LLM + Cartesia TTS).
    const session = new voice.AgentSession({
      stt: new deepgram.STT({
        model: 'nova-3',
        language,
      }),
      llm: new google.LLM({
        // Pinned to gemini-2.5-flash; see AGENT_MODEL comment in agent.ts
        // for why the 3-preview model is unsafe with the current plugin.
        model: 'gemini-2.5-flash',
      }),
      tts: new cartesia.TTS({
        model: 'sonic-3',
        voice: voiceId,
        language,
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad,
      // SDK 2026 surface: voiceOptions was flattened onto AgentSessionOptions
      // and `preemptiveGeneration` moved under turnHandling. Keeping the
      // explicit `enabled: true` even though it's the SDK default — makes
      // the intent obvious and survives any future default flip.
      turnHandling: {
        preemptiveGeneration: { enabled: true },
      },
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      // ev.item is `ChatMessage | AgentHandoffItem`; only the former has a role.
      if ('role' in ev.item && ev.item.role === 'user') userTurnCount++;
    });

    await session.start({
      agent: new Agent({ state, language, rituals }),
      room: ctx.room,
      inputOptions: {
        // LiveKit Cloud enhanced noise cancellation. For telephony you can
        // swap to `BackgroundVoiceCancellationTelephony` if voice quality
        // suffers, but mirroring narya's setup for now.
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    const firstLabel = rituals[0]?.label ?? 'your ritual';
    session.generateReply({
      instructions:
        `Greet briefly and explain you'll ask a few quick questions about ${rituals.length === 1 ? 'their ritual' : 'each of their rituals'} today. Then immediately ask the first tracking question for "${firstLabel}": whether they fulfilled it today.`,
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'tracking-agent',
  }),
);
