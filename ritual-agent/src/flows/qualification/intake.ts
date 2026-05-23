// Intake Agent — greeter, P1 gates, safety checks, and the single
// decision tool (gateDecision) that either ends the call or hands
// off to Capture.
//
// LiveKit Agents handoff API (verified against @livekit/agents v1.0.46):
//   - To hand off: return `llm.handoff({ agent: new OtherAgent(...), returns })`
//     from a tool's `execute`. The runtime detects the HANDOFF_SYMBOL and
//     swaps the active agent. STT/TTS/VAD on the session persist.
//   - To end the call instead: return any normal object from `execute`. The
//     calling agent keeps control.
//   - RunContext on `opts.ctx` exposes `.session` but NOT `.room`. We
//     capture the Room from JobContext at construction and close over it
//     in the tool's execute.
import { type JobContext, llm, voice } from '@livekit/agents';
import { type QualificationMeta } from '../../types/metadata';
import { CaptureAgent } from './capture';
import { buildIntakePrompt } from './prompts/intake-prompt';
import { type GateDecisionPayload, GateDecisionSchema } from './schema';

const SUBMIT_QUALIFICATION_URL = process.env.SUBMIT_QUALIFICATION_URL!;

export class IntakeAgent extends voice.Agent {
  constructor(meta: QualificationMeta, ctx: JobContext) {
    // Capture the room locally so the tool's `execute` closure can publish
    // outcome events to the frontend. `this.<x>` is unavailable inside the
    // super(...) call, so we use plain local bindings here.
    const room = ctx.room;
    const captureMeta = meta;
    const captureCtx = ctx;

    super({
      instructions: buildIntakePrompt(meta.language, meta.prospect_name),
      tools: {
        gateDecision: llm.tool({
          description:
            'Call EXACTLY ONCE when you have clearly established all three gate fields (decision_taken, behaviour_clarity, motivation_clarity). The runtime evaluates qualified vs disqualified from these fields; do not include any judgment of your own. If the prospect qualifies, this hands off to the Capture agent. Otherwise the conversation ends.',
          parameters: GateDecisionSchema,
          execute: async (raw: GateDecisionPayload) => {
            // Merge in identifiers we already have from the dispatch.
            // The LLM does not need to provide prospect_name / email /
            // language. contact_email is the identity field that drives
            // prospectKey for the rep's later /copilot lookup.
            const payload: GateDecisionPayload = {
              ...raw,
              prospect_name: captureMeta.prospect_name,
              language: captureMeta.language,
              ...(captureMeta.prospect_email
                ? { contact_email: captureMeta.prospect_email }
                : {}),
            };

            const qualified =
              payload.decision_taken === 'Y' &&
              payload.behaviour_clarity === 'clear' &&
              payload.motivation_clarity === 'clear';

            if (qualified) {
              return llm.handoff({
                agent: new CaptureAgent(captureMeta, captureCtx, payload),
                returns: { handedOff: true } satisfies GateDecisionToolResult,
              });
            }

            // DQ or safety: submit immediately with P1+safety data only.
            const resp = await fetch(SUBMIT_QUALIFICATION_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const data = (await resp.json()) as {
              ok: boolean;
              outcome: 'qualified' | 'disqualified';
              docId: string;
              prospectKey: string;
            };

            // Publish the outcome so the landing frontend swaps to <FinalScreen>.
            await room.localParticipant?.publishData(
              new TextEncoder().encode(
                JSON.stringify({ type: 'qualification:outcome', outcome: data.outcome }),
              ),
              { reliable: true },
            );

            return {
              handedOff: false,
              outcome: data.outcome,
            } satisfies GateDecisionToolResult;
          },
        }),
      },
    });
  }

  // Make Nova speak first. By default, LiveKit Agents waits for the first
  // user utterance. We override onEnter to trigger an immediate LLM turn
  // based on the system prompt's <opener> instructions, so the user doesn't
  // have to break the silence — the landing's welcome card promises this.
  override async onEnter(): Promise<void> {
    this.session.generateReply();
  }
}

export type GateDecisionToolResult =
  | { handedOff: true }
  | { handedOff: false; outcome: 'qualified' | 'disqualified' };
