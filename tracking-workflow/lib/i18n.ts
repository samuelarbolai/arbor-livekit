// Language-keyed strings the per-user workflow sends over SMS. Keep all
// user-facing copy here so the workflow + chat agent stay free of inline
// localization. Two languages for now (es, en); add more by extending
// the `Language` union and every map below.

import type { TrackingEvent } from './tracking-events';

export type Language = 'en' | 'es';

function normalize(lang: string | undefined): Language {
  return lang === 'es' ? 'es' : 'en';
}

// First SMS the user receives if voice didn't fully cover their KPIs.
// Tone matches the voice agent's broad opener: warm, brief, names the
// brand, and asks one open question. The chat agent then drives the
// rest of the conversation, extracting and following up.
const SMS_OPENERS: Record<Language, string> = {
  en:
    "Hi, this is the tracking agent from Samwise. We missed you on the call — could you tell me how you did today with your behaviour?",
  es:
    "Hola, soy el agente de seguimiento de Samwise. No pudimos hablar contigo en la llamada — ¿podrías contarme cómo te fue hoy con tu hábito?",
};

// Final link delivery copy. {{link}} is substituted at send time. The
// link itself is decided by `lib/links.ts` based on the merged KPIs;
// these messages are independent of which link won.
const LINK_INTROS: Record<Language, { newBelief: string; optimisation: string }> = {
  en: {
    newBelief:
      "Thanks. Since you've outgrown one of your rituals, here's a link to book a new-belief session: {{link}}",
    optimisation:
      "Thanks. Looks like you could use a tune-up — here's a link to book an optimisation session: {{link}}",
  },
  es: {
    newBelief:
      "Gracias. Como ya superaste uno de tus rituales, aquí tienes un enlace para agendar una sesión de nuevo enfoque: {{link}}",
    optimisation:
      "Gracias. Parece que te vendría bien un ajuste — aquí tienes un enlace para agendar una sesión de optimización: {{link}}",
  },
};

export function openerForLanguage(lang: string | undefined): string {
  return SMS_OPENERS[normalize(lang)];
}

// Picks the right intro by which link decideLink returned, then
// substitutes the URL. Caller passes both because decideLink already
// computed the URL and the workflow shouldn't re-derive which kind it
// is. Keeps the precedence rule (used-out → new-belief, else
// optimisation) entirely in `decideLink`.
export function linkMessageForLanguage(
  lang: string | undefined,
  link: string,
  kind: 'newBelief' | 'optimisation',
): string {
  const intros = LINK_INTROS[normalize(lang)];
  return intros[kind].replace('{{link}}', link);
}

// `decideLink` returns the URL but loses the "kind" — callers need to
// know which intro to wrap it in. Re-derive from the merged doc using
// the same precedence rule (used-out > failure). Trivial duplication
// of logic but keeps `links.ts`'s public API a single string and avoids
// a tuple-return refactor.
export function linkKindFor(
  ritualKpis: TrackingEvent['ritualKpis'],
): 'newBelief' | 'optimisation' | null {
  const bundles = Object.values(ritualKpis);
  if (bundles.some((b) => b.ritualUsedOut === true)) return 'newBelief';
  if (
    bundles.some(
      (b) =>
        b.relapse === true ||
        b.ritualFulfilled === false ||
        b.answeredCall === false,
    )
  ) {
    return 'optimisation';
  }
  return null;
}
