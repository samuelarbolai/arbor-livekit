// QualificationAgent — single-agent, one-prompt design.
//
// Tools the model uses:
//   - setVariables(...)  Live notes. Each committed variable publishes a
//                        `qualification:variable_update` data event to the
//                        room so the user's <VariablesPanel> updates live.
//                        The agent calls this whenever it has a verbatim
//                        quote to commit. Overwrites are allowed.
//   - endCall()          Signals a natural end. Invokes the worker's
//                        `onEndCall` callback (passed in via constructor).
//                        The worker then triggers the end-of-call
//                        extraction + submission. The same submission path
//                        is also triggered by `participantDisconnected` —
//                        the worker guards against double-submission.
//
// Agent ↔ scribe split (see programming-style.md / "converse → extract"):
//   - Agent's job: talk to the user, take accurate live notes.
//   - Extraction LLM's job (in `extractQualification` cloud function,
//     triggered by the worker on endCall or disconnect): read the full
//     transcript and emit the authoritative QualificationPayload —
//     including the inference fields the agent never touches
//     (decision_taken, behaviour_clarity, motivation_clarity,
//     symbolic_anchor_type, alternatives_exhaustion_level).
import { type JobContext, llm, voice } from '@livekit/agents';
import { z } from 'zod';
import { type QualificationMeta } from '../../types/metadata';
import { buildQualificationPrompt } from './prompts/qualification-prompt';

// The seven user-facing variables the agent commits via setVariables.
// These mirror the <variables> block in qualification-prompt.ts.
// Each variable is optional in any single call — the agent commits only
// the ones it has a verbatim user quote for in this turn. Fields are
// `.nullish()` (not `.optional()`): the OpenAI fallback emits `null` for
// fields it isn't setting, which `.optional()` (string | undefined) rejects —
// failing the whole setVariables call ("invalid arguments") so NO note is
// written. `.nullish()` accepts the null; the execute handler skips it.
const SetVariablesArgsSchema = z.object({
  behaviour_to_change: z
    .string()
    .nullish()
    .describe(
      "The specific verb-and-object action the user confirmed wanting to change. Must be a sentence (e.g. 'Pull out my phone and scroll Twitter when I sit down to prospect'), not a label. Only commit when the action is grounded in a concrete recent incident AND the user has confirmed it.",
    ),
  core_motivation: z
    .string()
    .nullish()
    .describe(
      "In the user's own words, what changing this unlocks for them — their answer to 'what would changing this unlock / why does it matter'. Commit ONLY from that explicit answer; NEVER from a confirmation like 'yes that's accurate', from the behaviour statement, or by inference. If the user hasn't stated their why yet, leave this empty and ask for it instead — a wrong value here makes the agent skip the question.",
    ),
  problem_duration_self_reported: z
    .string()
    .nullish()
    .describe(
      "How long it's been a struggle, in the user's words ('two years', 'since the divorce').",
    ),
  life_stage_context: z
    .string()
    .nullish()
    .describe(
      "Where the user is in life right now — work, family, what's loud.",
    ),
  symbolic_anchor_description: z
    .string()
    .nullish()
    .describe(
      "If the user draws strength from a tradition, philosophy, religion, or framework, their verbatim description of it. Skip if they don't have one.",
    ),
  alternatives_tried: z
    .string()
    .nullish()
    .describe(
      "What the user has already tried, on their own or with help. 'none' if they haven't tried anything.",
    ),
  why_alternatives_failed: z
    .string()
    .nullish()
    .describe(
      "For each thing they tried, what was missing. Empty if alternatives_tried is 'none'.",
    ),
});

const EndCallArgsSchema = z.object({});

export type QualificationAgentCallbacks = {
  /**
   * Called when the model invokes `endCall`. The worker uses this to
   * trigger the end-of-call extraction + submission. Idempotent — the
   * agent itself guards against double-calls, but the worker should also
   * guard since `participantDisconnected` is another submission trigger.
   */
  onEndCall: () => void;
};

export class QualificationAgent extends voice.Agent {
  constructor(
    meta: QualificationMeta,
    ctx: JobContext,
    callbacks: QualificationAgentCallbacks,
  ) {
    const room = ctx.room;
    const { onEndCall } = callbacks;
    let endCalled = false;

    super({
      instructions: buildQualificationPrompt(
        meta.language,
        meta.prospect_name,
        'voice',
      ),
      tools: {
        setVariables: llm.tool({
          description:
            'Write to your notes — the user sees these appear on screen as poster-style cards. Each parameter is a variable; supply only the ones you have a verbatim user quote for in this turn. Calls overwrite, so you can update a value later if the user clarifies. Call this the moment you have a quote to commit, not later. Multiple variables can be committed in a single call (e.g., a single long user turn fills three at once).',
          parameters: SetVariablesArgsSchema,
          execute: async (updates) => {
            const committed: string[] = [];
            for (const [name, value] of Object.entries(updates)) {
              if (typeof value !== 'string' || value.trim().length === 0) {
                continue;
              }
              try {
                await room.localParticipant?.publishData(
                  new TextEncoder().encode(
                    JSON.stringify({
                      type: 'qualification:variable_update',
                      name,
                      value,
                    }),
                  ),
                  { reliable: true },
                );
                committed.push(name);
              } catch {
                // Race with shutdown — ignore. The extraction LLM at end of
                // call will still pick up the value from the transcript.
              }
            }
            return { committed };
          },
        }),

        endCall: llm.tool({
          description:
            'Signal that the conversation is complete. You MUST speak your closing line BEFORE calling this. Takes no arguments. After this returns, the conversation ends and the extraction system processes the transcript.',
          parameters: EndCallArgsSchema,
          execute: async () => {
            if (endCalled) return { ok: true };
            endCalled = true;
            try {
              onEndCall();
            } catch {
              // Worker callback failed — log via runtime, but still report
              // ok to the model so it doesn't loop trying to retry endCall.
            }
            return { ok: true };
          },
        }),
      },
    });
  }

  // Make Nova speak first. By default LiveKit Agents waits for the first
  // user utterance; we want the warm opener the landing's welcome card
  // promises.
  override async onEnter(): Promise<void> {
    this.session.generateReply();
  }
}
