import { llm } from '@livekit/agents';
import { z } from 'zod';
import { readRitualDocTabsAsText } from '../../../services/drive';

// Returns an LLM tool factory bound to a single doc. The agent calls this
// whenever the user signals a section is filled, to verify the new content
// before moving on.
//
// SCOPE: this tool intentionally returns ONLY the three ritual-relevant tabs
// — "Behavioural picture", "Ritual", "Ritual Call". Other tabs in the Doc
// (Lapse Map, Possible origins, Ejemplo de ritual, Metadata) are deliberately
// excluded — those are therapist scratch space, an example from a different
// user, and structured config. Mirrors the cloud function's
// registerNewRitual tab-isolation (S4), so what the agent verifies during
// the call is exactly what the synthesis prompt receives afterwards.
export function makeReadDocTool(documentId: string) {
  return llm.tool({
    description: `Fetch the latest contents of the user's ritual Google Doc. ONLY reads the three ritual-relevant tabs: "Behavioural picture", "Ritual", and "Ritual Call". The other tabs in the Doc (Lapse Map, Possible origins, Ejemplo de ritual, Metadata) are deliberately excluded — those are therapist scratch space, an example from a different user, and structured config. You should not read, quote, paraphrase, or ask the user about content from those excluded tabs. Returns the three tabs as Markdown sections with "# <tab name>" headers. Call this whenever the user says they finished writing a section, or when you need to verify what is currently in the doc before responding. Do NOT call repeatedly within the same turn — one fetch per "I'm done" is enough.`,
    parameters: z.object({}),
    execute: async () => {
      try {
        const text = await readRitualDocTabsAsText(documentId);
        return text || '(the ritual-relevant tabs are empty)';
      } catch (err) {
        console.error('readGoogleDoc failed:', err);
        return 'error: could not read the document. ask the user to confirm sharing settings allow read access.';
      }
    },
  });
}
