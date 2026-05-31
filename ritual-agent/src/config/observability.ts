// observability.ts — MIRROR of samwise-backend/observability/observability-contract.ts
//
// This is the canonical conversation tagging contract, copied here because the
// agents are separate pnpm projects (no workspace). When you change the canonical
// file, change this mirror (and tracking-agent's) too — same rule as
// flows/qualification/schema.ts ↔ samwise-landing/lib/qualify/schema.ts.
//
// Langfuse-recognized OTel span attribute keys (verified against Langfuse's OTel
// attribute mapping):
//   langfuse.session.id        → groups spans into one session ("the call")
//   langfuse.trace.name        → human label in the trace list
//   langfuse.trace.tags        → string[] facets you filter by
//   langfuse.trace.metadata.*  → arbitrary per-key metadata
//
// The correlation key across Langfuse, conversationEvals/, and the cockpit
// deep-link is ALWAYS the LiveKit room name. Do not invent a second id.

export type ConversationFlow = 'qualification' | 'onboarding' | 'call' | 'tracking';

export interface ObsMeta {
  /** Which conversation this is. */
  flow: ConversationFlow;
  /** Call language — a useful Langfuse facet. */
  language: 'es' | 'en';
  /** LiveKit room name. The one correlation key. */
  sessionId: string;
  /** Prompt-variant id. Defaults to "default". The load-test suite varies this. */
  promptVariant?: string;
  /** Synthetic (load-test) session? Defaults to false. The cockpit filters these OUT of the funnel. */
  synthetic?: boolean;
  /** Optional prospect key for cross-referencing Firestore. */
  prospectKey?: string;
}

/**
 * Build the Langfuse-recognized OTel span attributes from ObsMeta.
 * Returned shape is a plain attribute bag (string | string[] values) so it stays
 * import-free and matches OpenTelemetry's Attributes type structurally.
 */
export function buildLangfuseAttributes(meta: ObsMeta): Record<string, string | string[]> {
  const variant = meta.promptVariant ?? 'default';
  const synthetic = meta.synthetic ?? false;
  const attrs: Record<string, string | string[]> = {
    'langfuse.session.id': meta.sessionId,
    'langfuse.trace.name': `${meta.flow} call`,
    'langfuse.trace.tags': [
      `flow:${meta.flow}`,
      `lang:${meta.language}`,
      synthetic ? 'synthetic' : 'prod',
      `variant:${variant}`,
    ],
    'langfuse.trace.metadata.flow': meta.flow,
    'langfuse.trace.metadata.language': meta.language,
    'langfuse.trace.metadata.prompt_variant': variant,
    'langfuse.trace.metadata.synthetic': String(synthetic),
  };
  if (meta.prospectKey) attrs['langfuse.trace.metadata.prospect_key'] = meta.prospectKey;
  return attrs;
}
