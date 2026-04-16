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

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });


export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    type Language = 'en' | 'es';

    // Everything enters through this metadata object, so you can pass any relevant information from your dispatch to the agent here.
    const metadata = ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {};
    const userInput = metadata.user_input;
    const userID = metadata.user_id || 'unknown_user';
    const language_selection = (metadata.language || 'en') as Language;
    const voice_id = metadata.voice_id || '03496517-369a-4db1-8236-3d3ae459ddf7';

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


    const language_instruction = {"es": "spanish", "en": "english"}[language_selection] || 'english';

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

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user and ask if they are hearing you well.',
    });

  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
