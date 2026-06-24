import { z } from 'zod';

// MIRROR of samwise-landing/lib/qualify/schema.ts — the landing-side file
// is the source of truth. When you change one, change both.
//
// In the worker, agent.ts uses its own inline schemas for the setVariables
// + endCall tools (kept inline because they're tightly coupled to the
// tool's execute closures). The schemas here are kept in lockstep with
// the landing for type-level parity and so any future code that needs to
// parse a QualificationPayload (e.g., the extraction LLM's response on
// the worker side) has a single zod source.

// ─── SetVariablesArgsSchema ────────────────────────────────────────────────
// Input schema for the agent's `setVariables` tool. The user-facing
// variables the agent commits as live notes during the conversation.
// All fields optional in any single call.
// NOTE: symbolic_anchor_description, alternatives_tried, why_alternatives_failed
// moved OUT of the Fit Assessment and INTO the Demo Call (captured live in the
// demo's Phase 1.5). The qualifying experience no longer touches them.
export const SetVariablesArgsSchema = z.object({
  behaviour_to_change: z.string().optional(),
  core_motivation: z.string().optional(),
  problem_duration_self_reported: z.string().optional(),
  life_stage_context: z.string().optional(),
});

export type SetVariablesArgs = z.infer<typeof SetVariablesArgsSchema>;

// ─── EndCallArgsSchema ──────────────────────────────────────────────────────
// Input schema for the agent's `endCall` tool — no arguments.
export const EndCallArgsSchema = z.object({});

// ─── QualificationPayloadSchema ────────────────────────────────────────────
// The full structured payload produced by the extractQualification cloud
// function from a conversation transcript.
export const QualificationPayloadSchema = z.object({
  prospect_name: z.string(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  language: z.enum(['es', 'en']),

  decision_taken: z.enum(['Y', 'N', 'unknown']),
  behaviour_clarity: z.enum(['clear', 'vague', 'unknown']),
  motivation_clarity: z.enum(['clear', 'vague', 'unknown']),

  behaviour_to_change: z.string().optional(),
  // Full grounded incident description (WHEN/WHERE/ACTIVITY/ACTION as a
  // noun-phrase). Phase 5b Step 1 anchor in /copilot. Extracted post-call
  // from the transcript — never live-committed during the conversation.
  behaviour_example: z.string().optional(),
  core_motivation: z.string().optional(),
  problem_duration_self_reported: z.string().optional(),
  life_stage_context: z.string().optional(),
  // symbolic_anchor_*, alternatives_tried, why_alternatives_failed and
  // alternatives_exhaustion_level moved to the Demo Call (captured live in
  // Phase 1.5) — no longer extracted by the Fit Assessment.
});

export type QualificationPayload = z.infer<typeof QualificationPayloadSchema>;
