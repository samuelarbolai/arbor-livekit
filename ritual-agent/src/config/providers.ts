import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import { type Language } from '../types/metadata';

// Pinned to gemini-2.5-flash. Do NOT bump to gemini-3-flash-preview: the
// installed @livekit/agents-plugin-google does not propagate `thought_signature`
// on follow-up tool-call parts, which causes a retry loop and ~6s of dead air
// before the AgentSession closes unrecoverably. Revisit when the plugin's
// CHANGELOG mentions thought_signature propagation.
export const AGENT_MODEL = 'gemini-2.5-flash';

export function makeStt(language: Language) {
  return new deepgram.STT({ model: 'nova-3', language });
}

export function makeLlm() {
  return new google.LLM({ model: AGENT_MODEL });
}

export function makeTts(language: Language, voiceId: string) {
  return new cartesia.TTS({ model: 'sonic-3', voice: voiceId, language });
}
