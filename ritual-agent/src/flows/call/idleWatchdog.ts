import { voice } from '@livekit/agents';
import { type Language } from '../../types/metadata';

// Idle watchdog. When BOTH sides have been quiet for IDLE_MS and the agent
// is in 'listening' state, fire a warm "are you still there?" check-in so
// the user doesn't have to nudge the agent themselves. Lifted from
// flows/qualification, pruned of the poor-audio branch (the call flow's
// system prompt has no mic-check protocol).
//
// Three load-bearing gates from the qualification flow:
//   1. Opener immunity   — don't fire until userTurnCount >= 1.
//   2. VAD heartbeat     — UserStateChanged='speaking' counts as activity
//                          even when STT hasn't committed a partial yet.
//   3. Refractory burned — the refractory window applies to every fire
//                          attempt, including bailouts, so a flapping
//                          state can't produce duplicate check-ins.
const IDLE_MS = 8_000;
const REFRACTORY_MS = 30_000;

const INSTRUCTIONS_BY_LANGUAGE: Record<Language, string> = {
  es: 'El usuario lleva ~8 s en silencio. Haz UN check-in breve y compasivo, en tu tono pastoral habitual (algo como "¿Sigues conmigo?" o "¿Me oyes bien?"). UNA sola frase.',
  en: 'The user has been silent for ~8 s. Make ONE brief, compassionate check-in in your pastoral voice ("Are you still with me?" or "Can you still hear me?"). ONE sentence only.',
};

export function attachIdleWatchdog(
  session: voice.AgentSession,
  language: Language,
): void {
  let userTurnCount = 0;
  let lastUserAudioAt = Date.now();
  let lastFireAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    clear();
    if (userTurnCount < 1) return;
    timer = setTimeout(() => {
      timer = null;
      const now = Date.now();
      if (now - lastFireAt < REFRACTORY_MS) return;
      if (
        session.agentState !== 'listening' ||
        session.userState === 'speaking' ||
        now - lastUserAudioAt < IDLE_MS
      ) {
        schedule();
        return;
      }
      lastFireAt = now;
      try {
        session.generateReply({
          instructions: INSTRUCTIONS_BY_LANGUAGE[language],
          allowInterruptions: true,
        });
      } catch {
        /* ignore — race with shutdown */
      }
    }, IDLE_MS);
  }

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, () => {
    lastUserAudioAt = Date.now();
    schedule();
  });

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    if (ev.newState === 'speaking') {
      lastUserAudioAt = Date.now();
      schedule();
    }
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (ev.newState === 'listening') {
      lastUserAudioAt = Date.now();
      schedule();
    } else {
      clear();
    }
  });

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type === 'message' && ev.item.role === 'user') {
      userTurnCount++;
    }
  });
}
