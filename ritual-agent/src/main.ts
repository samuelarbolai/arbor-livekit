import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { runCallFlow } from './flows/call';
import { runDemoCallFlow } from './flows/demo-call';
import { runOnboardingFlow } from './flows/onboarding';
import { runQualificationFlow } from './flows/qualification';
import { runQualificationTherapistFlow } from './flows/qualification-therapist';
import { runScribeFlow } from './flows/scribe';
import { parseDispatchMetadata } from './types/metadata';

// Load environment variables from a local file. In LiveKit Cloud the same
// vars are read from the deployed agent's secrets store; .env.local is only
// consulted by `pnpm dev`.
dotenv.config({ path: '.env.local' });

// Build marker. BUMP THIS on every deploy. It's logged at the start of every
// job so the worker logs unambiguously show which build served a given session
// — `lk agent status` only tells you the active version's deploy time, not
// which build handled a specific call (rollout can lag the build). See the
// samwise-livekit-agents skill, "Confirming which build served a session".
const BUILD_TAG = '2026-06-17-qualification-therapist';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    console.log(`[ritual-agent] build=${BUILD_TAG} job=${ctx.job.id}`);
    const meta = parseDispatchMetadata(ctx.job.metadata);
    switch (meta.flow) {
      case 'call':
        return runCallFlow(ctx, meta);
      case 'onboarding':
        return runOnboardingFlow(ctx, meta);
      case 'qualification':
        return runQualificationFlow(ctx, meta);
      case 'qualification-therapist':
        return runQualificationTherapistFlow(ctx, meta);
      case 'demo-call':
        return runDemoCallFlow(ctx, meta);
      case 'scribe':
        return runScribeFlow(ctx, meta);
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'ritual-agent',
  }),
);
