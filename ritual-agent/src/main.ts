import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { runCallFlow } from './flows/call';
import { runOnboardingFlow } from './flows/onboarding';
import { runQualificationFlow } from './flows/qualification';
import { parseDispatchMetadata } from './types/metadata';

// Load environment variables from a local file. In LiveKit Cloud the same
// vars are read from the deployed agent's secrets store; .env.local is only
// consulted by `pnpm dev`.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const meta = parseDispatchMetadata(ctx.job.metadata);
    switch (meta.flow) {
      case 'call':
        return runCallFlow(ctx, meta);
      case 'onboarding':
        return runOnboardingFlow(ctx, meta);
      case 'qualification':
        return runQualificationFlow(ctx, meta);
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'ritual-agent',
  }),
);
