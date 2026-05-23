import { z } from 'zod';

// Schema for the Intake Agent's `gateDecision` tool.
// Captures identifiers + P1 gates + safety gates.
// Once these three gate fields are known, the Intake Agent calls
// gateDecision, which routes the conversation:
//   qualified   → handoff to Capture
//   otherwise   → submit immediately, end the call
export const GateDecisionSchema = z.object({
  // Identifiers. prospect_name and language are collected on the
  // landing's picker (before the conversation) and arrive via dispatch
  // metadata — the LLM does NOT supply them through this tool, so they
  // are optional here. The tool's `execute` merges them in from the
  // captured meta before posting to the cloud function.
  prospect_name: z.string().optional(),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  language: z.enum(['es', 'en']).optional(),

  // Priority 1 — disqualification gates
  decision_taken: z.enum(['Y', 'N']),
  behaviour_clarity: z.enum(['clear', 'vague']),
  motivation_clarity: z.enum(['clear', 'vague']),
});

export type GateDecisionPayload = z.infer<typeof GateDecisionSchema>;

// Schema for the Capture Agent's `submitQualification` tool — and for
// text-mode's single submit tool. Extends the gate schema with the
// nine P2 (verbatim) fields. Field names mirror the Fit Assessment doc
// and `samwise-app/app/copilot/demo-call-config.ts` so /copilot can
// pre-fill key-for-key.
export const QualificationPayloadSchema = GateDecisionSchema.extend({
  behaviour_to_change: z.string().optional(),
  core_motivation: z.string().optional(),
  problem_duration_self_reported: z.string().optional(),
  life_stage_context: z.string().optional(),
  symbolic_anchor_type: z
    .enum(['religious', 'philosophical', 'esoteric', 'hyper-rational', 'none'])
    .optional(),
  symbolic_anchor_description: z.string().optional(),
  alternatives_tried: z.string().optional(),
  why_alternatives_failed: z.string().optional(),
  alternatives_exhaustion_level: z.enum(['low', 'medium', 'high']).optional(),
});

export type QualificationPayload = z.infer<typeof QualificationPayloadSchema>;
