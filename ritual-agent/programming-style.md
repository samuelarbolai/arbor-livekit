# programming-style.md — ritual-agent

LiveKit-agent patterns specific to this module. Distilled from the `samwise-livekit-agents` skill — that skill remains the canonical, longer-form reference, but the patterns most relevant to writing code in `flows/<name>/` are here so a code agent doesn't need to reload the skill mid-task.

## 1. LiveKit Agent Patterns

### A. XML-Tagged Structural Prompting

System prompts use XML-style tag blocks for sections, not Markdown headings. The model parses the structure better and you get more reliable behavior across edits.

```text
<personality>
You are ${name}. ${persona}
</personality>

<goal>
Your only job is to ...
</goal>

<hard-rules>
- ONE question per turn. Maximum.
- ...
</hard-rules>
```

Canonical references:
- `flows/qualification/prompts/qualification-prompt.ts`
- `flows/onboarding/prompts/agent.ts`

### B. Zod-Validated Tool Inputs

Tool input schemas are Zod-defined inline in the agent file (close to the `execute` they validate). Each field gets `.describe(...)` so Gemini sees per-field intent.

```ts
const SetVariablesArgsSchema = z.object({
  behaviour_to_change: z.string().optional().describe(
    "The verb-and-object action the user confirmed wanting to change. Sentence, not a label."
  ),
  // ...
});

llm.tool({
  description: "...",
  parameters: SetVariablesArgsSchema,
  execute: async (updates) => { /* ... */ },
});
```

For schemas shared across the worker + landing (qualification only), keep the canonical version in `samwise-landing/lib/qualify/schema.ts` and mirror it in `flows/qualification/schema.ts`. See `context-for-code-agent.md` → "Sources of truth."

### C. Lifecycle State via Closures

Per-call state (counts, flags, accumulated values) is captured in **closure variables inside `runXFlow(ctx, meta)`** — not on the Agent class, not in module-level singletons. This guarantees a fresh state for each new dispatch, which matters because the worker process is reused across calls.

```ts
export async function runQualificationFlow(ctx: JobContext, meta: QualificationMeta) {
  let userTurnCount = 0;
  let submitted = false;          // idempotency guard for end-of-call submission
  let outcome: 'qualified' | 'disqualified' | 'abandoned' = 'abandoned';

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type === 'message' && ev.item.role === 'user') userTurnCount++;
  });

  // ... rest of the flow uses these closure-scoped lets ...
}
```

### D. Agent Wait-For-User Override

The LiveKit JS Agents SDK default is "agent waits for the first user utterance." Without override, the worker sits silent in the room until the user speaks — even if your prompt's `<opener>` says "Your first utterance must do X."

If your UX promises the agent greets first (every WebRTC flow in this repo does), override `onEnter` in the Agent class:

```ts
export class QualificationAgent extends voice.Agent {
  // ...
  override async onEnter(): Promise<void> {
    this.session.generateReply();
  }
}
```

Do NOT `await` the call — `generateReply()` returns a `SpeechHandle`, not a Promise; awaiting blocks `onEnter` until the entire reply streams.

### E. Verbal Filler on Long LLM Turns

Long context + slow models = dead air. Listen for `AgentStateChanged → thinking`, set a timeout, fire `session.say` with `addToChatCtx: false`:

```ts
const FILLER_THRESHOLD_MS = 4_000;
const FILLER_TEXT = meta.language === 'es' ? 'Mmm.' : 'Hmm.';
let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
  if (ev.newState === 'thinking') {
    thinkingTimer = setTimeout(() => {
      thinkingTimer = null;
      try { session.say(FILLER_TEXT, { addToChatCtx: false }); } catch { /* race */ }
    }, FILLER_THRESHOLD_MS);
  } else if (thinkingTimer) {
    clearTimeout(thinkingTimer);
    thinkingTimer = null;
  }
});
```

Load-bearing details:
- **`addToChatCtx: false`** — without it the LLM sees its own filler in history and gets confused. Non-negotiable.
- **`try/catch`, not `.catch()`** — `session.say()` returns a `SpeechHandle`, not a Promise.
- **Language-aware text** — read `meta.language` from dispatch metadata.

### F. Idle Shutdown (WebRTC flows only)

Phone calls are bounded by SIP. Web sessions can sit forever with the user in another tab. WebRTC flows MUST attach an idle handler:

```ts
import { attachIdleShutdown } from '../onboarding/idleHandler';
// ...
attachIdleShutdown(ctx, session); // 10 min default
```

Canonical implementation: `flows/onboarding/idleHandler.ts`. Reused by `flows/qualification/`. Resets on `ConversationItemAdded`; fires `ctx.shutdown('idle_timeout')` after the threshold.

### G. WebRTC Mic Quality — Four Linked Patterns

For any web flow (qualification, onboarding, future), these four work together to handle bad mics:

1. **`preemptiveGeneration: false`** on `AgentSession` constructor (omit `voiceOptions` block entirely). Default is fine for phone (`flows/call`), catastrophic for web.
2. **Confidence rolling window** on `ChatMessage.transcriptConfidence` (NOT on `UserInputTranscribedEvent`, which has no confidence field). Sample on `ConversationItemAdded`; hysteresis trip (enter at avg < 0.65, exit at > 0.80) so a single bad transcript doesn't flap.
3. **Idle watchdog with three gates**: (1) `userTurnCount >= 1` (infinite patience on opener), (2) VAD heartbeat (`UserStateChanged → 'speaking'` resets timer), (3) refractory burned on every fire attempt including bailouts (30s — prevents duplicates). Canonical: `flows/qualification/index.ts`.
4. **`<audio-quality>` prompt block** between `<closing>` and `<hard-rules>` defining: "transcript probably broken" signals, anti-parroting rule (duplicated in `<hard-rules>`), mic-test protocol after one round of "could you repeat?", graceful close path if still broken. Bilingual where the agent is bilingual.

### H. Tool Result Shape Conventions

Tool `execute` returns shape what the LLM consumes as the tool result message:

- **For "continue" tools**: return a minimal acknowledgement (`{ committed: ['behaviour_to_change'] }`, `{ ok: true }`). Anything large bloats every subsequent LLM call's input.
- **For "terminal" tools**: still return small — the model speaks ONE closing line based on what's in the prompt, not based on the tool result. Don't put long copy in tool results.

For tools that publish data events to the room (e.g., `setVariables` publishing `qualification:variable_update`), do the publish INSIDE the `execute` — that way the frontend updates before the LLM produces its next turn. Use `try/catch` and ignore failures; the publish racing with shutdown is normal.

## 2. Shared TypeScript Idioms

### Lookup tables over switch/if-else

```ts
const VOICE_ID_BY_LANGUAGE: Record<Language, string> = {
  en: '5ee9feff-...',
  es: 'b042270c-...',
};
const voiceId = VOICE_ID_BY_LANGUAGE[meta.language];
```

### Lazy singletons for expensive clients

```ts
let driveClient: ReturnType<typeof google.drive> | null = null;
function getDriveClient() {
  if (driveClient) return driveClient;
  // ... construct once ...
  return driveClient;
}
```

Pattern used in `services/drive.ts`, `services/firestore.ts`.

### Pragmatic safety with `!` and `as`

Env vars known at runtime: `process.env.EXTRACT_QUALIFICATION_URL!`. Inbound JSON shapes: cast inside the function body where the JSON is parsed (`req.body as ExpectedShape`). Don't import a shared types package for these; declare the interface inline.

### Discriminated unions for dispatch metadata

```ts
export type DispatchMeta =
  | { flow: 'call'; /* fields */ }
  | { flow: 'onboarding'; /* fields */ }
  | { flow: 'qualification'; /* fields */ };
```

Parser in `types/metadata.ts`. Default missing `flow` to the existing flow (`call`) for backwards-compat with legacy dispatches.

## 3. Don'ts (Hard-Won Negative Rules)

- **Don't bump to `gemini-3-flash-preview`**. The installed `@livekit/agents-plugin-google` doesn't propagate `thought_signature` on follow-up tool calls → 6s dead air + AgentSession close. Pin to `gemini-2.5-flash` until the plugin CHANGELOG mentions thought_signature propagation.
- **Don't use `inference.*` (LiveKit Inference)**. This repo uses direct provider plugins. Mixing produces subtle tool-calling threshold differences.
- **Don't create a sibling `*-agent/` module for a new conversation flow** of an existing user-facing agent. Add a new `flows/<name>/` folder instead. See `samwise-livekit-agents` skill + memory `feedback_livekit_agent_routes.md`.
- **Don't put a system prompt in `main.ts`**. Each flow owns its prompts under `flows/<name>/prompts/`.
- **Don't use `BackgroundVoiceCancellationTelephony` on web flows.** Telephony NC is tuned for narrowband audio with codec artifacts; it over-corrects on a clean WebRTC mic.
- **Don't replace `inference.LLM` from the starter tests** — narya's `agent.test.ts` uses `new google.LLM({ model: AGENT_MODEL })` directly. Mirror that.
- **Don't put the Dockerfile HuggingFace-cache patch back to the starter default.** `lk agent init` ships a Dockerfile that loses the model cache between build and production stages. The patch (`cp -r /root/.cache/huggingface /app/.cache/huggingface` + `ENV HF_HOME=/app/.cache` in prod stage) is mandatory.

See `samwise-livekit-agents` skill for the full "don't repeat" list including SIP trunk (Telnyx, not Twilio) and voiceID policy.
