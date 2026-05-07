import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice, llm
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent';
import * as google from '@livekit/agents-plugin-google';
import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { initializeApp, cert } from 'firebase-admin/app';
import { SipClient, TwirpError } from "livekit-server-sdk";

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT!;

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  }

  initializeApp({
    credential: cert(JSON.parse(raw)),
  });

  firebaseInitialized = true;
}

export async function setFallbackActive(reason: string, userID: string, status: boolean) {
  initFirebase();
  console.log(`Setting fallback status to ${status} for user ${userID} due to: ${reason}`);
  const db = getFirestore();
  const snapshot = await db.collection("rituals")
    .where("userID", "==", userID)
    .get();

  return snapshot.docs[0]!.ref.update({
    fallback_active: status,
  });
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    type Language = 'en' | 'es';

    const LIVEKIT_URL = process.env.LIVEKIT_URL!;
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
    const SIP_OUTBOUND_TRUNK_ID = process.env.SIP_OUTBOUND_TRUNK_ID!;

    const sipClient = new SipClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET
    );

    const trunkId = SIP_OUTBOUND_TRUNK_ID;

    // Everything enters through this metadata object, so you can pass any relevant information from your dispatch to the agent here.
    const metadata = ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {};
    const userInput = metadata.user_input;
    const userID = metadata.user_id || 'unknown_user';
    const language_selection = (metadata.language || 'en') as Language;
    const phoneNumber = metadata.phone_number || 'unknown_number';
    const voice_id = metadata.voice_id || '03496517-369a-4db1-8236-3d3ae459ddf7';
    const roomName = metadata.room_name || 'unknown_room';

    const sipParticipantOptions = {
      participantIdentity: phoneNumber,
      participantName: `Test Caller: ${phoneNumber}`,
      krispEnabled: true,
      waitUntilAnswered: true,
    };

    // Join the room and connect to the user
    await ctx.connect();

    try {
      const participant = await sipClient.createSipParticipant(
        trunkId,
        phoneNumber,
        roomName,
        sipParticipantOptions
      );
      console.log("Participant created:", participant.participantIdentity);
    } catch (error) {
      if (error instanceof TwirpError) {
        console.error(`Twirp error creating SIP participant: ${error.code} - ${error.message}`);
      } else {
        console.error("Unknown error creating SIP participant:", error);
      }
    }

    let participant;
    try {
      participant = await ctx.waitForParticipant(phoneNumber);
    } catch (err) {
      await setFallbackActive('sip_connection_failed', userID, true);
      ctx.shutdown();
      return;
    }

    // Set up a voice AI pipeline using OpenAI, Cartesia, Deepgram, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new deepgram.STT({
        model: 'nova-3',
        language: language_selection,
      }),

      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all providers at https://docs.livekit.io/agents/models/llm/
      llm: new google.LLM({
        model: 'gemini-3-flash-preview',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new cartesia.TTS({
        model: 'sonic-3',
        voice: voice_id,
        language: language_selection,
      }),

      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: true,
      },
    });

    // To use a realtime model instead of a voice pipeline, use the following session setup instead.
    // (Note: This is for the OpenAI Realtime API. For other providers, see https://docs.livekit.io/agents/models/realtime/))
    // 1. Install '@livekit/agents-plugin-openai'
    // 2. Set OPENAI_API_KEY in .env.local
    // 3. Add import `import * as openai from '@livekit/agents-plugin-openai'` to the top of this file
    // 4. Use the following session setup instead of the version above
    // const session = new voice.AgentSession({
    //   llm: new openai.realtime.RealtimeModel({ voice: 'marin' }),
    // });

    let userTurnCount = 0;

    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      (ev) => {
        if (ev.item.role === 'user') {
          userTurnCount++;
        }
      }
    );

    ctx.addShutdownCallback(async () => {
      if (userTurnCount === 0) {
        await setFallbackActive('no_user_turns', userID, true);
      } else {
        await setFallbackActive('no_user_turns', userID, false);
      }
    });

    const language_instruction = { "es": "spanish", "en": "english" }[language_selection] || 'english';

    const initialCtx = llm.ChatContext.empty();
    initialCtx.addMessage({
      role: 'system',
      content: `
      <user-inputs>
        ${userID}
        ${userInput}
      </user-inputs>
      <language>
        You are a native ${language_instruction} speaker. Speak only in ${language_instruction}. The user is also a native ${language_instruction}s speaker.
      </language>
      `,
    });


    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: new Agent(initialCtx, ctx),
      room: ctx.room,
      inputOptions: {
        // LiveKit Cloud enhanced noise cancellation
        // - If self-hosting, omit this parameter
        // - For telephony applications, use `BackgroundVoiceCancellationTelephony` for best results
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

  },

});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'ritual-agent',
  }),
);
