import { voice } from '@livekit/agents';
import { type Language } from '../../types/metadata';

// Verbal filler. If the LLM stays in `thinking` for more than the threshold,
// inject a soft conversational acknowledgment so the user doesn't sit in
// silence on long Gemini turns. addToChatCtx: false keeps it out of the
// model's own context so it never sees the filler as part of the transcript.
// Lifted from flows/qualification — same problem, same fix.
const FILLER_THRESHOLD_MS = 4_000;
const FILLER_TEXT_BY_LANGUAGE: Record<Language, string> = {
  en: 'Hmm.',
  es: 'Mmm.',
};

export function attachThinkingFiller(
  session: voice.AgentSession,
  language: Language,
): void {
  const text = FILLER_TEXT_BY_LANGUAGE[language];
  let timer: ReturnType<typeof setTimeout> | null = null;

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (ev.newState === 'thinking') {
      timer = setTimeout(() => {
        timer = null;
        try {
          session.say(text, { addToChatCtx: false });
        } catch {
          /* ignore — race with shutdown */
        }
      }, FILLER_THRESHOLD_MS);
    } else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
}
