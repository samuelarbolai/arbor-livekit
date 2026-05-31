// observability-contract.ts — CANONICAL source for the conversation tagging contract.
//
// This file is the single source of truth for how every Samwise conversation is
// tagged in Langfuse. It is MIRRORED into each agent (separate pnpm projects, no
// workspace) per the repo's existing mirror convention — e.g.
//   ritual-agent/src/config/observability.ts
//   tracking-agent/src/config/observability.ts
// When you change this file, change every mirror.
//
// The attribute KEYS below are the ones Langfuse recognizes from OTel spans
// (verified against Langfuse's OTel attribute mapping):
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
  /** Call language — drives nothing here but is a useful Langfuse facet. */
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
 * Returned shape is a plain attribute bag (string | string[] values) so it can be
 * mirrored into any agent without importing @opentelemetry/api types.
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
