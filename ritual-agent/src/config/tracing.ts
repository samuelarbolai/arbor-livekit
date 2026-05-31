// tracing.ts — Langfuse OTel wiring for the worker (observability Phase 1).
//
// The LiveKit Agents framework emits a span tree per turn (LLM / STT / TTS /
// tool calls, with gen_ai.* + lk.* attributes). setTracerProvider() from
// @livekit/agents/telemetry routes that tree to a provider of our choosing —
// here, a NodeTracerProvider feeding the Langfuse span processor (same packages
// and shape as samwise-landing/instrumentation.ts). The result: every call
// becomes a Langfuse session grouped by room name.
//
// Two ordering hazards this module is built around:
//   1. We do NOT live in main.ts — main.ts calls cli.runApp() at module top
//      level, so importing it from a flow would relaunch the CLI. Flows import
//      THIS module instead.
//   2. ES imports hoist above main.ts's dotenv.config(). So the provider is
//      created LAZILY (first init/apply call, at job time) — never at import —
//      otherwise process.env.LANGFUSE_* would be read before dotenv populates
//      them in `pnpm dev`.

// The telemetry API is exposed via the main entry's `telemetry` namespace.
// @livekit/agents does NOT expose a `./telemetry` subpath in its exports map,
// so `import ... from '@livekit/agents/telemetry'` does not resolve under
// moduleResolution: bundler — use the namespace.
import { telemetry } from '@livekit/agents';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { buildLangfuseAttributes, type ObsMeta } from './observability';

// @livekit/agents bundles OpenTelemetry SDK v1 types; @langfuse/otel requires
// SDK v2 (see memory reference-langfuse-nextjs-setup). The clash is NOMINAL
// only — both share @opentelemetry/api@1.9.x at runtime, so LiveKit gets a
// tracer from our v2 provider and its spans flow through the Langfuse v2
// processor correctly. Bridge the two SDK type copies with a cast.
type LkTracerProvider = Parameters<typeof telemetry.setTracerProvider>[0];

let provider: NodeTracerProvider | null = null;

// Lazily build + register the provider once per worker process. Idempotent.
// No-ops gracefully (the Langfuse processor just drops spans) if LANGFUSE_* are
// unset, so a partial deploy is safe.
function ensureProvider(): NodeTracerProvider {
  if (provider) return provider;
  // Guard for exactOptionalPropertyTypes: LangfuseSpanProcessorParams' keys are
  // typed `string`, so we can't hand them `string | undefined`. Only attach the
  // processor when all three are present; otherwise the provider has no
  // processors and tracing no-ops (safe for a partial deploy).
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  const spanProcessors =
    publicKey && secretKey && baseUrl
      ? [new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl })]
      : [];
  if (spanProcessors.length === 0) {
    console.warn('[tracing] LANGFUSE_* not fully set — conversation tracing disabled');
  }
  provider = new NodeTracerProvider({ spanProcessors });
  telemetry.setTracerProvider(provider as unknown as LkTracerProvider);
  return provider;
}

/** Phase 1 Step 1 — register the provider at worker boot (call from prewarm). */
export function initTracing(): void {
  ensureProvider();
}

/**
 * Phase 1 Step 2 (Candidate A) — re-point the provider for THIS job, injecting
 * the conversation's Langfuse attributes (session id = room name, flow, tags,
 * metadata) into its spans. Call once at the top of each runXFlow, after
 * ctx.connect().
 *
 * Candidate A matches LiveKit's own doc example (per-job metadata). The metadata
 * is global to the provider, so if Langfuse ever shows cross-talk between two
 * calls running concurrently on one worker, switch to the active-root-span
 * approach documented in observability/current-plan.md (Phase 1 Step 2,
 * Candidate B).
 */
export function applyConversationTracing(meta: ObsMeta): void {
  telemetry.setTracerProvider(ensureProvider() as unknown as LkTracerProvider, {
    metadata: buildLangfuseAttributes(meta),
  });
}
