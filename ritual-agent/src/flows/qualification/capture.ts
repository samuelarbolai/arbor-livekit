// Capture Agent — runs ONLY on the qualified path. Its only tool is
// `submitQualification`, which posts the full payload (P1+safety+P2)
// to the cloud function and publishes the outcome to the room.
import { type JobContext, llm, voice } from '@livekit/agents';
import { type QualificationMeta } from '../../types/metadata';
import { buildCapturePrompt } from './prompts/capture-prompt';
import {
  type GateDecisionPayload,
  type QualificationPayload,
  QualificationPayloadSchema,
} from './schema';

const SUBMIT_QUALIFICATION_URL = process.env.SUBMIT_QUALIFICATION_URL!;

export class CaptureAgent extends voice.Agent {
  constructor(meta: QualificationMeta, ctx: JobContext, p1AndSafety: GateDecisionPayload) {
    const room = ctx.room;
    const captureMeta = meta;

    super({
      instructions: buildCapturePrompt(meta.language, p1AndSafety),
      tools: {
        submitQualification: llm.tool({
          description:
            'Call EXACTLY ONCE at the end of the capture phase with the full payload (P1+safety+P2). Returns the outcome string from the server.',
          parameters: QualificationPayloadSchema,
          execute: async (raw: QualificationPayload) => {
            // Merge in identifiers from dispatch (LLM doesn't supply
            // these). contact_email is what makes the qualification
            // doc findable by /copilot via email search.
            const payload: QualificationPayload = {
              ...raw,
              prospect_name: captureMeta.prospect_name,
              language: captureMeta.language,
              ...(captureMeta.prospect_email
                ? { contact_email: captureMeta.prospect_email }
                : {}),
            };
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

            await room.localParticipant?.publishData(
              new TextEncoder().encode(
                JSON.stringify({ type: 'qualification:outcome', outcome: data.outcome }),
              ),
              { reliable: true },
            );

            return { outcome: data.outcome };
          },
        }),
      },
    });
  }
}
