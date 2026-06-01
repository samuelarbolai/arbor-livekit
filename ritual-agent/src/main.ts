import { type JobContext, type JobProcess, ServerOptions, cli, defineAgent } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { initTracing } from './config/tracing';
import { runCallFlow } from './flows/call';
import { runOnboardingFlow } from './flows/onboarding';
import { runQualificationFlow } from './flows/qualification';
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
const BUILD_TAG = '2026-05-31-tracing-nonfatal';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Register the Langfuse tracer provider once per worker process (observability
    // Phase 1 Step 1). Per-call attributes are attached by each flow via
    // applyConversationTracing(). Runs here (not at module top level) so it's
    // after dotenv.config() — env vars are populated by the time prewarm fires.
    initTracing();
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
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'ritual-agent',
  }),
);
