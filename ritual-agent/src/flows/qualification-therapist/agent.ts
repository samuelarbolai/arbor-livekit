// TherapistQualificationAgent — MIRROR of QualificationAgent
// (flows/qualification/agent.ts). Tools, callbacks, onEnter and structure are
// identical; only the prompt and the four committed variables differ.
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
//   - Extraction LLM's job (in `extractQualificationTherapist` cloud
//     function, triggered by the worker on endCall or disconnect): read the
//     full transcript and emit the authoritative therapist payload.
import { type JobContext, llm, voice } from '@livekit/agents';
import { z } from 'zod';
import { type QualificationTherapistMeta } from '../../types/metadata';
import { buildTherapistQualificationPrompt } from './prompts/qualification-therapist-prompt';

// The user-facing variables the agent commits via setVariables.
// These mirror the <variables> block in qualification-therapist-prompt.ts.
// Each variable is optional in any single call — the agent commits only
// the ones it has a verbatim user quote for in this turn. Fields are
// `.nullish()` (not `.optional()`): the OpenAI fallback emits `null` for
// fields it isn't setting, which `.optional()` (string | undefined) rejects —
// failing the whole setVariables call ("invalid arguments") so NO note is
// written. `.nullish()` accepts the null; the execute handler skips it.
const SetVariablesArgsSchema = z.object({
  patient_addiction_type: z
    .string()
    .nullish()
    .describe(
      "The addiction(s) the user's patients usually present with, in their own words. Only commit when the user has answered the first question and you have a verbatim quote.",
    ),
  last_patient_occurrence: z
    .string()
    .nullish()
    .describe(
      "When the user last had a patient with this problem, in their own words ('last week', 'I'm seeing one right now', 'a few months ago').",
    ),
  helped_patient_attempts: z
    .string()
    .nullish()
    .describe(
      "What the user has tried to help that patient, in their own words. Verbatim — do not summarize.",
    ),
  why_attempts_failed: z
    .string()
    .nullish()
    .describe(
      "Why, in the user's view, that has failed to work, in their own words. Verbatim — do not summarize.",
    ),
});

const EndCallArgsSchema = z.object({});

export type QualificationTherapistAgentCallbacks = {
  /**
   * Called when the model invokes `endCall`. The worker uses this to
   * trigger the end-of-call extraction + submission. Idempotent — the
   * agent itself guards against double-calls, but the worker should also
   * guard since `participantDisconnected` is another submission trigger.
   */
  onEndCall: () => void;
};

export class TherapistQualificationAgent extends voice.Agent {
  constructor(
    meta: QualificationTherapistMeta,
    ctx: JobContext,
    callbacks: QualificationTherapistAgentCallbacks,
  ) {
    const room = ctx.room;
    const { onEndCall } = callbacks;
    let endCalled = false;

    super({
      instructions: buildTherapistQualificationPrompt(
        meta.language,
        meta.prospect_name,
        'voice',
      ),
      tools: {
        setVariables: llm.tool({
          description:
            'Write to your notes — the user sees these appear on screen as poster-style cards. Each parameter is a variable; supply only the ones you have a verbatim user quote for in this turn. Calls overwrite, so you can update a value later if the user clarifies. Call this the moment you have a quote to commit, not later. Multiple variables cannot be committed in a single call.',
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
                // Race with shutdown — ignore. The extraction LLM still reads the transcript.
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
              // Worker callback failed — still report ok so the model doesn't loop.
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
