import { llm } from '@livekit/agents';
import { z } from 'zod';
import { readGoogleDocAsText } from '../../../services/drive';

// Returns an LLM tool factory bound to a single doc. The agent calls this
// whenever the user signals a section is filled, to verify the new content
// before moving on.
export function makeReadDocTool(documentId: string) {
  return llm.tool({
    description: `Fetch the latest plain-text contents of the user's ritual Google Doc. Call this whenever the user says they finished writing a section, or when you need to verify what is currently in the doc before responding. Returns the entire doc as text. Do NOT call repeatedly within the same turn — one fetch per "I'm done" is enough.`,
    parameters: z.object({}),
    execute: async () => {
      try {
        const text = await readGoogleDocAsText(documentId);
        return text || '(the doc is empty)';
      } catch (err) {
        console.error('readGoogleDoc failed:', err);
        return 'error: could not read the document. ask the user to confirm sharing settings allow read access.';
      }
    },
  });
}
