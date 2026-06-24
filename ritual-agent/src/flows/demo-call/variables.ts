// Worker-side mirror of the Demo Call variable contract in
// samwise-app/app/copilot/demo-call-config.ts (DEMO_CALL_VARIABLES). The
// app-side config is the SOURCE OF TRUTH for the variable list, the
// `userVisible` set, and the qualify→demo prefill mapping — change both
// together. The agent only needs: which variables exist, which are broadcast
// to the prospect's screen, and how to hydrate prefill from a qualification
// doc. The rich per-variable cleaning semantics (frameworkSemantics) live
// app-side (cleanVariable) and do NOT apply here — the agent speaks
// script-fit values directly, so there is no live cleaning step.

// The variables the prospect watches fill on their screen during the call.
// Must equal the `userVisible` set in demo-call-config.ts AND the landing
// /meet receiver's allowed keys. Broadcast as `demo-call:variable_update`.
export const USER_VISIBLE_NAMES: ReadonlySet<string> = new Set([
  'behaviour_to_change',
  'core_motivation',
  'symbolic_anchor_description',
  'alternatives_tried',
  'why_alternatives_failed',
  'life_stage_context',
  'problem_duration_self_reported',
]);

// Qualification-doc fields copied 1:1 into the demo state (same name).
// symbolic_anchor_*, alternatives_tried, why_alternatives_failed and
// alternatives_exhaustion_level are NO LONGER prefilled — they moved into the
// Demo Call (captured live in Phase 1.5; see DEMO_CAPTURE_VAR_NAMES).
export const QUALIFICATION_SAME_NAME_FIELDS = [
  'prospect_name',
  'behaviour_to_change',
  'behaviour_example',
  'core_motivation',
  'life_stage_context',
  'problem_duration_self_reported',
] as const;

// Cross-name prefills: a qualification field → a differently-named demo
// variable. Mirrors DERIVED_PREFILLS in demo-call-config.ts.
export const DERIVED_PREFILLS: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'behaviour_to_change', to: 'actions_during_relapse' },
];

// Every variable the agent may capture or judge live via setVariables. The
// enum constrains the tool so the model can't invent a name; the per-phase
// dynamic block supplies what each one means in context, so we don't repeat
// the cleaning semantics here. Prefilled values the prospect may CORRECT in
// Phase 1.5 are included; pure rep-prep fields (call_date, rep_name,
// age_range, …) are not — the agent never sets those.
export const DEMO_CAPTURE_VAR_NAMES = [
  // Phase 1.5 — corrections to prefilled values, plus the three captured live
  // here (moved out of the Fit Assessment): symbolic_anchor_description,
  // alternatives_tried, why_alternatives_failed.
  'behaviour_to_change',
  'core_motivation',
  'symbolic_anchor_description',
  'alternatives_tried',
  'why_alternatives_failed',
  // Phase 3 — Bond
  'referral',
  'expectation',
  // Phase 5b — functional analysis (in step order)
  'actions_during_relapse',
  'feelings_during_relapse',
  'intention_behind_action',
  'thoughts_during_relapse',
  'self_talk_after_relapse',
  'view_of_their_life_in_that_moment',
  'consequences_for_them',
  'grado_de_identificacion', // low | medium | high
  // Phase 7 — solution intro
  'biologic_symbolic_analogy', // flu | cold | allergy | diabetes | cancer | other
  // Phase 8 — mantra + re-classify
  'clinical_picture_description',
  'fit_state', // qualified | still_disqualified — drives the [CONDITION] branch
  // Phase 14 — alternatives rebound (cost)
  'time_spent_in_alternatives',
  'total_money_spent_in_alternatives',
  'monthly_budget_willingness',
  // Post-call
  'outcome', // closed | follow-up | disqualified | no
  'next_step',
  'rep_notes',
] as const;

export type DemoCaptureVarName = (typeof DEMO_CAPTURE_VAR_NAMES)[number];

// fit_state default — the close path (phases 9-15) is visible until the agent
// re-classifies at Phase 8.5. Mirrors demo-call-config.ts's defaultValue.
export const DEFAULT_FIT_STATE = 'qualified';

// Brand-fixed voice, reusing the qualify table (decided 2026-06-01).
export { QUALIFICATION_VOICE_ID_BY_LANGUAGE as DEMO_VOICE_ID_BY_LANGUAGE } from '../../config/voiceIds';
