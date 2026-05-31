import { llm } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import * as openai from '@livekit/agents-plugin-openai';
import { type Language } from '../types/metadata';

// Pinned to gemini-2.5-flash. Do NOT bump to gemini-3-flash-preview: the
// installed @livekit/agents-plugin-google does not propagate `thought_signature`
// on follow-up tool-call parts, which causes a retry loop and ~6s of dead air
// before the AgentSession closes unrecoverably. Revisit when the plugin's
// CHANGELOG mentions thought_signature propagation.
export const AGENT_MODEL = 'gemini-2.5-flash';

type GoogleLlmOptions = NonNullable<ConstructorParameters<typeof google.LLM>[0]>;
export type SafetySettings = GoogleLlmOptions['safetySettings'];

// BLOCK_NONE across the four standard harm categories. The qualification flow
// is a clinical behaviour-change intake where sensitive topics (addiction,
// pornography) are expected. Gemini's default safety thresholds soft-block that
// content — returning empty completions (finishReason STOP, zero output tokens)
// that the plugin retries to exhaustion, stranding the caller in silence. Pass
// this ONLY for that flow; call/onboarding keep Gemini's defaults.
// (safetySettings reaches the SDK via the local patch on
// @livekit/agents-plugin-google, which 1.2.1 otherwise drops.)
export const UNFILTERED_SAFETY_SETTINGS: SafetySettings = (
  [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ] as const
).map((category) => ({ category, threshold: 'BLOCK_NONE' })) as SafetySettings;

export function makeStt(language: Language) {
  return new deepgram.STT({ model: 'nova-3', language });
}

export function makeLlm(safetySettings?: SafetySettings) {
  // thinkingBudget: 0 — DISABLE Gemini thinking entirely. This is the
  // load-bearing fix for the reasoning-leak. includeThoughts:false + the
  // thought-drop patch only stop reasoning that arrives as `thought:true`
  // PARTS; they do NOT catch reasoning the model bleeds into a plain `{text}`
  // part. gemini-2.5-flash in thinking mode (via @livekit/agents-plugin-google)
  // intermittently serializes its scratchpad — and even tool calls — as content
  // text glued to the reply, which is then spoken aloud. Observed on BOTH
  // flows/call ("SILENT THINKING ...", 2026-05-30) and flows/qualification
  // ("tool_code print(default_api.setVariables(...)) thought ... <reply>",
  // 2026-05-29) — the latter with preemptiveGeneration already OFF, proving
  // preemptiveGeneration is NOT the cause. No thinking phase => no scratchpad to
  // serialize => no leak. The reasoning+reply arrive GLUED in one text part (one
  // speech_id), so a stream/ttsNode strip can't separate them; killing thinking
  // at the source is the only robust fix that stays on Gemini. includeThoughts:
  // false stays as a backstop for the thought-PART vector. A server-side-reasoning
  // model (OpenAI o-series) would also avoid the leak but is too slow for live
  // voice; see the samwise-livekit-agents skill, "Gemini thinking". The plugin's
  // validator rejects thinkingBudget < 0, so 0 (not -1) is the disable value.
  return new google.LLM({
    model: AGENT_MODEL,
    thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    ...(safetySettings ? { safetySettings } : {}),
  });
}

// OpenAI fallback model for the qualification flow. Cheap/fast and only runs on
// turns Gemini couldn't produce; bump to 'gpt-4o' / 'gpt-4.1' if fallback-turn
// quality matters more than cost.
const FALLBACK_MODEL = 'gpt-4o-mini';

// Qualification LLM: Gemini primary, OpenAI fallback. gemini-2.5-flash
// intermittently returns empty completions (a known model bug — see the
// samwise-livekit-agents skill, "Gemini empty completions"). When it does,
// FallbackAdapter produces the turn via OpenAI instead, preserving chat context
// and tools. maxRetryPerLLM bounds Gemini's attempts so escalation stays well
// under our ~15s budget; OpenAI runs only on turns where every Gemini attempt
// emptied. stallRecovery.ts remains the final net if even the fallback fails.
// Requires OPENAI_API_KEY in the agent's secrets (and .env.local for `pnpm dev`).
// maxRetryPerLLM is tunable — raise it to push more turns back onto Gemini,
// lower it for faster escalation; confirm the real split from the FallbackAdapter
// "Provider succeeded" / "switching to next LLM" logs after deploy.
export function makeQualificationLlm(safetySettings?: SafetySettings) {
  return new llm.FallbackAdapter({
    llms: [makeLlm(safetySettings), new openai.LLM({ model: FALLBACK_MODEL })],
    maxRetryPerLLM: 3,
  });
}

export function makeTts(language: Language, voiceId: string) {
  return new cartesia.TTS({ model: 'sonic-3', voice: voiceId, language });
}
