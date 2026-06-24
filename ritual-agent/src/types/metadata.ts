export type Language = 'en' | 'es';

// CallMeta — phone-ritual flow (existing, dispatched by makeCallsBatchFunction).
export interface CallMeta {
  flow: 'call';
  user_id: string;
  user_input: string;
  language: Language;
  phone_number: string;
  voice_id: string;
  room_name: string;
}

// OnboardingMeta — web doc-guidance flow (new, dispatched by samwise-app).
// Prior-session variables (helpers_list, core_motivation,
// daily_activity_to_face_reality) come from the onboarding/comp call that
// runs BEFORE this Call Design Session — they are looked up server-side
// when the dispatch is created and injected here so the agent can reference
// them by name during the conversation.
export interface OnboardingMeta {
  flow: 'onboarding';
  ritual_id: string;
  google_doc_id: string;
  language: Language;
  helpers_list: string;
  core_motivation: string;
  daily_activity_to_face_reality: string;
}

// QualificationMeta — web first-touch Fit Assessment flow.
// Dispatched by samwise-landing/app/api/qualify/voice-init when a
// prospect picks a language and enters the voice room. The prospect
// types their name AND email on the landing picker before the call
// starts; both arrive here in metadata. Name is threaded into the
// prompt (the agent confirms pronunciation in its opener). Email is
// merged into the submit-tool payload as `contact_email` so the
// qualification doc's `prospectKey` derives from email — the rep
// later searches /copilot by email and finds the doc. (The LLM never
// re-asks for name or email.)
export interface QualificationMeta {
  flow: 'qualification';
  language: Language;
  persona: 'nova';
  prospect_name: string;
  prospect_email: string;
}

// QualificationTherapistMeta — web first-touch Fit Assessment for THERAPISTS.
// A mirror of QualificationMeta (same fields) dispatched by samwise-landing's
// qualify voice-init when the picker's audience selection is "therapist". The
// only thing that distinguishes it is the flow value, which routes to the
// therapist flow (different opener + 4 questions + always-books close).
export interface QualificationTherapistMeta {
  flow: 'qualification-therapist';
  language: Language;
  prospect_name: string;
  prospect_email: string;
}

// DemoCallMeta — web autonomous Demo Call (~50 min). Dispatched by the
// demo-call entry path (walk-in/init for an autonomous booking). prospect_email
// hydrates the qualification prefill server-side at call start; script_doc_url
// lets the Doc be overridden (defaults to the canonical Demo Doc in script.ts).
export interface DemoCallMeta {
  flow: 'demo-call';
  language: Language;
  prospect_name: string;
  prospect_email: string;
  script_doc_url: string;
}

// ScribeMeta — silent transcription agent for HUMAN↔human /meet calls (walk-in
// or scheduled). Dispatched by samwise-app's walk-in/init when a call has NO AI
// guide (autonomous calls already transcribe via the demo-call agent). The
// scribe needs nothing but the language for Deepgram; it discovers the human
// participants from the room and publishes per-speaker transcriptions.
export interface ScribeMeta {
  flow: 'scribe';
  language: Language;
}

export type DispatchMeta =
  | CallMeta
  | OnboardingMeta
  | QualificationMeta
  | QualificationTherapistMeta
  | DemoCallMeta
  | ScribeMeta;

// Backwards compatibility: existing makeCallsBatchFunction dispatches don't
// include `flow`. Default missing/unrecognized flow to 'call' so the production
// phone agent keeps working during the rollout.
export function parseDispatchMetadata(raw: string | undefined | null): DispatchMeta {
  const m = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const flow = (m.flow as string) ?? 'call';
  const language = ((m.language as string) ?? 'en') as Language;

  if (flow === 'onboarding') {
    return {
      flow: 'onboarding',
      ritual_id: String(m.ritual_id ?? ''),
      google_doc_id: String(m.google_doc_id ?? ''),
      language,
      helpers_list: String(m.helpers_list ?? ''),
      core_motivation: String(m.core_motivation ?? ''),
      daily_activity_to_face_reality: String(m.daily_activity_to_face_reality ?? ''),
    };
  }

  if (flow === 'qualification') {
    const persona = (m.persona as string) === 'nova' ? 'nova' : 'nova';
    return {
      flow: 'qualification',
      language,
      persona,
      prospect_name: String(m.prospect_name ?? '').trim() || 'friend',
      prospect_email: String(m.prospect_email ?? '').trim(),
    };
  }

  if (flow === 'qualification-therapist') {
    return {
      flow: 'qualification-therapist',
      language,
      prospect_name: String(m.prospect_name ?? '').trim() || 'friend',
      prospect_email: String(m.prospect_email ?? '').trim(),
    };
  }

  if (flow === 'demo-call') {
    return {
      flow: 'demo-call',
      language,
      prospect_name: String(m.prospect_name ?? '').trim() || 'friend',
      prospect_email: String(m.prospect_email ?? '').trim(),
      script_doc_url: String(m.script_doc_url ?? ''),
    };
  }

  if (flow === 'scribe') {
    return { flow: 'scribe', language };
  }

  return {
    flow: 'call',
    user_id: String(m.user_id ?? 'unknown_user'),
    user_input: String(m.user_input ?? ''),
    language,
    phone_number: String(m.phone_number ?? 'unknown_number'),
    voice_id: String(m.voice_id ?? '03496517-369a-4db1-8236-3d3ae459ddf7'),
    room_name: String(m.room_name ?? 'unknown_room'),
  };
}
