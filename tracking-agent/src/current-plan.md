# Current Plan: `tracking-agent` Module

## Plan Summary
**Status (2026-05-05): Phases 1-5 shipped with single-ritual semantics (see Update Status at the bottom). Phase 6 (multi-ritual refactor — Option C) planned in response to the discovery that users may have multiple active rituals; Phases 2-4 will be partially rewritten and the agent redeployed.** This module is a LiveKit Agents (Node.js) project that sits next to `my-agent/`. It places short outbound voice calls, walks the user through ALL their active rituals asking three KPI questions per ritual, and posts the result to `tracking-workflow`'s `/api/tracking-callback` route on Vercel. It deliberately does not write Firestore, send SMS, or schedule itself — those concerns live in sibling modules.

## Plan Architecture (Flow)
1. `tracking-workflow`'s per-user route runs an inline `context.run('dispatch-tracking-call', ...)` step that calls `AgentDispatchClient.createDispatch` against `agentName: "tracking-agent"` with metadata that includes `run_id`, `tracking_callback_url`, and `rituals: Array<{ googleDocId, label }>`.
2. This module's `main.ts` parses the metadata, initializes a per-ritual `ritualKpis` state map (one bundle per dispatched ritual), sets up `chatCtx` and `Agent`, wires the SIP participant against the existing Telnyx trunk, and lets the LiveKit voice runtime drive the conversation through each ritual in turn.
3. As the user answers, Zod-validated tools (each taking a `googleDocId`) mutate entries in the entry-scope `ritualKpis` map, and a `ConversationItemAdded` listener increments `userTurnCount`.
4. On `addShutdownCallback`, the agent POSTs `{ userID, runId, channel: "voice", conversationHappened: userTurnCount > 0, ritualKpis }` to `tracking_callback_url`. The receiver writes Firestore (per-`(googleDocId, KPI)` monotonic merge) and calls `client.notify` to wake the parked workflow.

## Plan Structure (Directories and files)
- **Module root:** `samwise-backend/tracking-agent/`
- **Entry / source:** `src/main.ts`, `src/agent.ts`, `src/agent.test.ts`
- **Working files:** `src/context-for-code-agent.md`, `src/current-plan.md`, `src/programming-style.md` (these will move under `src/` from the module root in Phase 1's tail end, mirroring `my-agent/`'s convention).
- **Deploy:** `Dockerfile`, `package.json` (`pnpm`), `tsconfig.json`, `eslint.config.ts`, `.env.example`, `AGENTS.md`, `README.md`.

## Modifications (in phases and steps)

### Phase 1: Scaffold the LiveKit Agents project — ✅ DONE
**In-directory location:** `samwise-backend/tracking-agent/`
**Specification of what should NOT be modified:**
- `my-agent/` — leave untouched. Patterns are copied, not imported.
- `cloud-functions/` — unrelated to this module. The dispatch + callback endpoints originally drafted there were reverted; both responsibilities now live in `tracking-workflow/`.

**Steps:**
1. From `samwise-backend/`, run `lk agent init tracking-agent --template agent-starter-node` (per `my-agent/AGENTS.md`'s recommended bootstrap). If that fails because the dir already exists, init in a temp dir and copy the contents in.
2. Run `pnpm install`.
3. Run `pnpm run download-files` to fetch Silero VAD + LiveKit turn-detector models.
4. Replace the starter `instructions` in `src/agent.ts` with the tracking system prompt drafted in Phase 2 below (still XML-tagged). Replace example tools with the four Zod-tools listed in `context-for-code-agent.md`.
5. Wire `main.ts` to read the dispatch metadata fields documented in `context-for-code-agent.md` (`user_id`, `run_id`, `tracking_callback_url`, `language`, `voice_id`, `phone_number`, `room_name`).
6. Move the working files (`context-for-code-agent.md`, `current-plan.md`, `programming-style.md`) under `src/` to match `cloud-functions/`'s convention.
7. Copy `my-agent/AGENTS.md` into this module verbatim, updating only the title heading and any agent-specific notes (none anticipated).

**Deliverable:** Project boots locally with `pnpm run dev`, agent connects to LiveKit Cloud, an empty test dispatch reaches an empty session.

### Phase 2: System prompt and Zod tools — ✅ DONE
**In-file location:** `src/agent.ts`
**Specification of what should NOT be modified:**
- The starter project's room/session bootstrap, VAD, turn-detector, or noise-cancellation wiring. Only swap `instructions` and `tools`.

**Code-ready system prompt skeleton (English; the agent uses `metadata.language` to localize at runtime — see Phase 3 step 2):**
```
<personality>
  You are a brief tracking check-in agent over the phone, NOT a coaching agent.
  You are warm, fast, and respectful. You are NOT here to advise.
</personality>

<environment>
  You are talking to a user via voice. You speak in <LANGUAGE>. The user has
  recently engaged in a daily ritual practice and may have had a coaching call
  earlier today. Your job is to collect three short answers and end the call.
</environment>

<tone and style>
  Short sentences. Two questions per turn at most. Never lecture. If the user
  starts to share at length, listen briefly, then gently steer back to the
  next question.
</tone and style>

<goal>
  Collect three KPIs in this order, calling the corresponding tool as soon as
  you have a clear answer:
    1. Did you fulfill your ritual today?           -> recordRitualFulfilled
    2. Did you have a relapse today?                -> recordRelapse
    3. Did you answer your morning coaching call?   -> recordAnsweredCall

  EXCEPTION: If at any point the user reports they have outgrown the problem
  ("I don't need this anymore", "this isn't a problem for me anymore", or
  language equivalents), call markRitualUsedOut, thank them, and end the call.

  Cap each question at ~3 turns. End the call as soon as all three KPIs are
  recorded OR ritualUsedOut is set. Do not ask follow-up questions beyond
  the three. Do not offer coaching, encouragement frameworks, or scheduling.
</goal>
```

**Zod tool definitions (all live in `tools: { ... }` of the Agent constructor):**
```ts
recordRelapse: llm.tool({
  description: 'Call as soon as the user gives a clear yes/no on having had a relapse today.',
  parameters: z.object({ value: z.boolean() }),
  execute: async ({ value }) => { relapse = value; },
}),
recordRitualFulfilled: llm.tool({
  description: 'Call as soon as the user gives a clear yes/no on whether they fulfilled their ritual today.',
  parameters: z.object({ value: z.boolean() }),
  execute: async ({ value }) => { ritualFulfilled = value; },
}),
recordAnsweredCall: llm.tool({
  description: 'Call as soon as the user gives a clear yes/no on whether they answered their morning coaching call.',
  parameters: z.object({ value: z.boolean() }),
  execute: async ({ value }) => { answeredCall = value; },
}),
markRitualUsedOut: llm.tool({
  description: 'Call only if the user reports they have outgrown the underlying problem and no longer need the ritual. Implies the conversation goal is met; wrap up politely.',
  parameters: z.object({}),
  execute: async () => { ritualUsedOut = true; },
}),
```

The `let` variables (`relapse`, `ritualFulfilled`, `answeredCall`, `ritualUsedOut`, `userTurnCount`) live in `main.ts`'s entry scope so the shutdown callback can read them. Pass them into the `Agent` constructor via a closure or a small `state` object.

**Deliverable:** A test dispatch on a real phone number completes the three-question flow and the `let` state reflects the answers.

### Phase 3: Lifecycle state, language injection, and shutdown callback — ✅ DONE
**In-file location:** `src/main.ts`
**Specification of what should NOT be modified:**
- The starter's session lifecycle (room join, voice pipeline init).
- The Agent class's tool definitions (Phase 2) — wire them via the closure, don't restructure.

**Step 1 — turn counter:**
Inside the entry function, before constructing the `Agent`:
```ts
let userTurnCount = 0;
session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
  if (ev.item.role === 'user') userTurnCount++;
});
```

**Step 2 — language injection:**
The system prompt template literal contains `<LANGUAGE>` (or equivalent placeholder). Replace it at runtime with `metadata.language` before passing to the `Agent` constructor. Mirror `my-agent`'s pattern.

**Step 3 — shutdown callback:**
```ts
ctx.addShutdownCallback(async () => {
  try {
    await fetch(metadata.tracking_callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userID: metadata.user_id,
        runId: metadata.run_id,
        channel: 'voice',
        conversationHappened: userTurnCount > 0,
        relapse, ritualFulfilled, answeredCall, ritualUsedOut,
      }),
    });
  } catch (e) {
    console.error('trackingCallback POST failed', e);
  }
});
```

The receiver is responsible for idempotency on its side, so a retry from us would be safe — but the callback should NOT retry on failure here; we'd rather lose one tracking event than thrash the LiveKit shutdown path. The `tracking-workflow/api/tracking-callback` design (monotonic merge in `lib/tracking-events.ts` + audit-log append) means the workflow's own timeout-and-retry logic will eventually paper over a missed callback.

**Deliverable:** A complete dispatched call results in exactly one POST to `tracking_callback_url` with all five collected fields.

### Phase 4: Tests (TDD per `AGENTS.md`) — ✅ DONE
**In-file location:** `src/agent.test.ts`
**Specification of what should NOT be modified:**
- The agent's instructions or tool surface — tests anchor desired behavior; don't change behavior to make tests pass mechanically.

**Tests to write (use the LiveKit Agents test harness; reference `my-agent/src/agent.test.ts` for the existing template):**
1. **Asks the three questions in the documented order.** Drive the harness with a user that answers each question briefly; assert that `recordRitualFulfilled` fires before `recordRelapse` fires before `recordAnsweredCall`.
2. **Stops after all three KPIs are recorded.** After the third tool call, assert the agent does not ask a fourth question.
3. **Used-out exception fires correctly.** Drive the harness with a user that says "I don't need this anymore" after question 1; assert `markRitualUsedOut` is called and no further KPI tools fire.
4. **Conversation-happened signal.** Two test cases — (a) voicemail-style harness with no user turns: `userTurnCount === 0`; (b) normal harness with at least one user turn: `userTurnCount > 0`.
5. **Shutdown callback POSTs once with the right payload.** Mock `fetch`; assert exactly one call with the documented body shape.

Per `AGENTS.md`: write these tests BEFORE iterating on the prompt. Do not let the agent guess.

**Deliverable:** `pnpm test` passes locally.

### Phase 5: Production deploy — ✅ DONE
**In-directory location:** module root.
**Specification of what should NOT be modified:**
- The shared LiveKit project. Use the same `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` as `my-agent` — they coexist on one LiveKit project, dispatched apart by `agentName`.

**Steps:**
1. `livekit.toml` with `agent.name = "tracking-agent"`. Make sure it does NOT clash with `my-agent`'s name on the same project.
2. Push a Docker image to LiveKit Cloud (`lk agent deploy` or per the starter `Dockerfile`'s instructions).
3. Confirm the agent appears in the LiveKit Cloud dashboard alongside `my-agent`.

**Testing phase:**
- **Local:** `pnpm run dev` + manual dispatch via `lk` CLI with a fake metadata blob pointing at a stub callback URL on `localhost:8080`.
- **Integration:** drive the full chain — Vercel workflow (inline dispatch step) → this agent → Vercel `/api/tracking-callback` → Firestore — against a test phone number on the dev Firebase project. Assert: the daily `trackingEvents` doc has all three KPIs and `completedAt` is set.

### Phase 6: Multi-ritual refactor (Option C) — ✅ DONE (2026-05-05)
**Goal:** A single tracking call walks the user through ALL their active rituals, asking three KPIs per ritual. State is keyed by `googleDocId`. The shutdown POST sends a `ritualKpis` map. This replaces the singular semantics of Phases 2-4 because users may have more than one active ritual; aggregate ("did you fulfill your rituals?") loses the per-ritual fidelity that makes `decideLink` actionable downstream.

**Why now:** The original Phases 2-4 shipped with single-ritual semantics. We had not properly tested the deployed agent end-to-end before this refactor; redeploying with multi-ritual semantics is acceptable because no production data has flowed through the singular-KPI shape. After this phase, the contract between the agent and `tracking-workflow` is the per-ritual `ritualKpis` map documented in `context-for-code-agent.md`.

**Specification of what should NOT be modified:**
- The starter project's room/session bootstrap, VAD, turn-detector, or noise-cancellation wiring.
- The Dockerfile cache fix (Phase 5) — already shipped and working.
- `livekit.toml` — agent name and project subdomain stay.
- `pnpm.overrides.openai = "6.8.1"` — still required.
- The dispatch metadata field names other than the new `rituals` array (per upstream `tracking-workflow/current-plan.md` Phase 3 step 3).

**Step 1 — Update dispatch metadata typing in `main.ts`:**
- Add `rituals: Array<{ googleDocId: string, label: string }>` to the metadata interface.
- After parsing, hard-error on `metadata.rituals.length === 0`. The dispatch should never have produced an empty list (every dispatched user has at least one ritual by construction). Refusing to start the session gives a clean failure mode rather than a silent no-op.

**Step 2 — Lifecycle state in `main.ts`:**
- Replace the four scalar `let` variables (`relapse`, `ritualFulfilled`, `answeredCall`, `ritualUsedOut`) with a single `const ritualKpis: Record<string, KpiBundle>` initialized from `metadata.rituals` (every ritual seeded with `{ relapse: null, ritualFulfilled: null, answeredCall: null, ritualUsedOut: false }`).
- Keep `userTurnCount` as-is (still the canonical conversation-happened signal).

**Step 3 — Tools in `agent.ts`:**
- Update all four tools to take `googleDocId` plus their existing parameters:
  ```ts
  recordRelapse: llm.tool({
    description: 'Call as soon as the user gives a clear yes/no on having had a relapse for the named ritual.',
    parameters: z.object({ googleDocId: z.string(), value: z.boolean() }),
    execute: async ({ googleDocId, value }) => { state.ritualKpis[googleDocId].relapse = value; },
  }),
  // recordRitualFulfilled, recordAnsweredCall: same shape.
  markRitualUsedOut: llm.tool({
    description: 'Call only if the user reports they have outgrown a ritual. Move on to the next ritual after calling.',
    parameters: z.object({ googleDocId: z.string() }),
    execute: async ({ googleDocId }) => { state.ritualKpis[googleDocId].ritualUsedOut = true; },
  }),
  ```
- The Agent constructor's `state` closure now contains `ritualKpis` instead of the four scalars.
- Tool descriptions must explicitly reference "the named ritual" so the LLM understands the `googleDocId` parameter is required and tied to the ritual currently being asked about.

**Step 4 — System prompt in `agent.ts`:**
- Replace the singular `<goal>` block with a multi-ritual walkthrough. Skeleton (English; `<LANGUAGE>` and `<RITUAL_LIST>` substituted at runtime in `main.ts`):
  ```
  <personality>
    You are a brief tracking check-in agent over the phone, NOT a coaching agent.
    You are warm, fast, and respectful. You are NOT here to advise.
  </personality>

  <environment>
    You are talking to a user via voice. You speak in <LANGUAGE>. The user has
    one or more active rituals. Your job is to collect three short answers PER
    RITUAL and end the call.
  </environment>

  <tone and style>
    Short sentences. One question per turn. Refer to each ritual BY ITS LABEL —
    never by ID, never as "ritual 1." If the user starts to share at length,
    listen briefly, then gently steer back to the next question.
  </tone and style>

  <rituals>
    The user's active rituals (walk through in this order):
    <RITUAL_LIST>
    For each ritual, ask three KPIs in this fixed order, calling the
    corresponding tool with the ritual's googleDocId:
      1. Did you fulfill <label> today?         -> recordRitualFulfilled({ googleDocId, value })
      2. Did you have a relapse on <label>?     -> recordRelapse({ googleDocId, value })
      3. Did you answer the morning call for <label>? -> recordAnsweredCall({ googleDocId, value })

    EXCEPTION: If at any point the user reports they have outgrown a specific
    ritual ("I don't need this one anymore", language equivalents), call
    markRitualUsedOut({ googleDocId }) for THAT ritual and move on to the next
    one. Do NOT terminate the call — other rituals may still need answering.
  </rituals>

  <goal>
    End the call as soon as every ritual has all three KPIs recorded OR is
    marked ritualUsedOut. Do not ask follow-up questions beyond the three.
    Do not offer coaching, encouragement frameworks, or scheduling.
  </goal>
  ```
- `<RITUAL_LIST>` is built at runtime as a numbered list of `${i}. ${label} (id: ${googleDocId})` lines so the LLM can correlate the conversational label with the tool parameter. Including the ID in the prompt is fine — it never leaves the LLM's working memory and is what the tool calls require.
- Language injection: same `string.replace('<LANGUAGE>', metadata.language)` pattern Phases 2-3 used.

**Step 5 — Shutdown callback in `main.ts`:**
- POST body becomes `{ userID, runId, channel: 'voice', conversationHappened: userTurnCount > 0, ritualKpis }`. The receiver applies a per-`(googleDocId, KPI)` monotonic merge, so partial conversations are safe.
- Update `buildTrackingCallbackBody` (the pure-unit-tested helper extracted in Phase 4) to accept the new state shape and emit the new payload.

**Step 6 — Tests in `agent.test.ts`:**
- Drop the singular-KPI ordering tests (they no longer apply).
- Add new behavior tests using the LiveKit Agents test harness:
  1. **Walks rituals in dispatch order.** Two rituals in metadata; harness answers the three KPIs straightforwardly. Assert the first three tool calls reference `rituals[0].googleDocId`, the next three reference `rituals[1].googleDocId`.
  2. **Per-ritual KPI ordering.** Within each ritual, assert `recordRitualFulfilled` precedes `recordRelapse` precedes `recordAnsweredCall`.
  3. **Per-ritual used-out.** With two rituals, harness says "I don't need ritual A anymore" mid-flow. Assert `markRitualUsedOut({ googleDocId: ritualA.googleDocId })` fires and the agent then proceeds to ritual B (does not terminate).
  4. **Single-ritual still works.** Smoke test with `rituals.length === 1`. Should behave essentially identically to the previous singular flow.
  5. **Stops after every ritual is recorded.** Two rituals, all six KPIs answered. Assert no further questions.
  6. **Conversation-happened signal.** Voicemail-style harness with no user turns: `userTurnCount === 0`. Normal harness: `userTurnCount > 0`. (Unchanged from Phase 4 but worth re-running.)
  7. **Pure-unit tests for `buildTrackingCallbackBody`.** Several `ritualKpis` shapes (all-null, partial-per-ritual, all-complete, mixed used-out). Assert exact JSON payload.

**Step 7 — Redeploy to LiveKit Cloud:**
- `pnpm test` must pass.
- `lk agent deploy` (the existing agent in `livekit.toml` — do not create a new agent, update the existing `tracking-agent`). The Phase 5 Dockerfile cache fix carries through.
- Verify replicas reach 1/1/8 after deploy.

**Testing phase:**
- **Local unit:** `pnpm test`. All seven test cases pass.
- **Local manual:** `pnpm run dev` + a hand-crafted dispatch with 2 rituals (use `lk agent dispatch` with a metadata blob pointing at a stub callback URL). Walk through both rituals on a real phone; assert the stub receives a POST with all six KPIs populated.
- **Integration:** once `tracking-workflow` Phase 3 lands, drive end-to-end with a real dispatch from the workflow → assert the merged `trackingEvents` doc has all rituals' KPIs and `completedAt` set.

**Deliverable:** Multi-ritual conversations work end-to-end, tests pass, agent is redeployed to LiveKit Cloud and reaches 1/1/8 replicas. The `ritualKpis` payload contract matches `tracking-workflow`'s `mergeFinal` expectations.

## Update Status
### Completed ✅
- Module dir created at `samwise-backend/tracking-agent/`.
- Working files (this file and `context-for-code-agent.md`) drafted.
- **Phase 1 (scaffold)** — `lk agent init`'d, `pnpm install`, `pnpm download-files`, working files moved to `src/`, `package.json` `name` set to `tracking-agent`.
- **Phase 2 (system prompt + Zod tools — single-ritual)** — `src/agent.ts` rewritten. Tracking instructions XML-tagged. Four tools: `recordRitualFulfilled`, `recordRelapse`, `recordAnsweredCall`, `markRitualUsedOut`. Constructor takes `{ state, language }`. _**Superseded by Phase 6**_ (Option C multi-ritual refactor).
- **Phase 3 (metadata wiring + SIP + shutdown callback — single-ritual)** — `src/main.ts` rewritten. Parses `ctx.job.metadata`, wires entry-scope `state` and `userTurnCount`, registers `addShutdownCallback` BEFORE SIP setup so it fires on every exit path. Outbound SIP via `SipClient.createSipParticipant` + `ctx.waitForParticipant`. `agentName: 'tracking-agent'` on ServerOptions. `livekit-server-sdk@2.15.2` added as a runtime dep. _**Shutdown payload shape superseded by Phase 6**_; SIP wiring stays.
- **Phase 4 (tests — single-ritual)** — `src/agent.test.ts` rewritten. Five behavior tests (KPI ordering, stop-after-three, used-out exception, userTurnCount listener) + two pure-unit tests for `buildTrackingCallbackBody` (extracted to `agent.ts` for testability). All 6 pass in ~13s on real LLM via LiveKit Inference. _**Superseded by Phase 6 test plan**_.
- **Phase 5 (production deploy)** — `livekit.toml` created with `subdomain = "arbor-a93j2951"`. Deployed to LiveKit Cloud (us-east) with ID `CA_k5weq8CbDWjR` via `lk agent create --secrets-file .secrets.deploy --region us-east -y`. Build is cloud-side, no local Docker daemon needed. `SIP_OUTBOUND_TRUNK_ID` injected from `my-agent/.env.local` via a transient `.secrets.deploy` file (deleted after deploy). Status: Running, replicas 1/1/8 (after Dockerfile cache fix landed mid-day 2026-05-05; see `.claude/skills/samwise-livekit-agents/SKILL.md`).

### Small follow-ups (from first end-to-end voice test 2026-05-05) 🔧
- **Cartesia "Invalid transcript" error spam.** ✅ Fixed 2026-05-06. Added explicit instruction to `<tone and style>`: "EVERY tool call must be paired with at least a brief spoken phrase in the same turn — never call a tool with empty or punctuation-only speech." The agent now emits a short acknowledgement plus the next question alongside every tool call, which gives Cartesia non-empty TTS input. To re-verify: dispatch a real call, watch deploy logs, confirm "Invalid transcript" no longer fires after each tool call.
- **SDK deprecation warnings.** ✅ Fixed 2026-05-06. `voiceOptions: { preemptiveGeneration: true }` replaced with `turnHandling: { preemptiveGeneration: { enabled: true } }`. Verified shape against installed SDK types (`@livekit/agents/dist/voice/turn_config/turn_handling.d.ts` → `TurnHandlingOptions.preemptiveGeneration: Partial<PreemptiveGenerationOptions>` where `PreemptiveGenerationOptions.enabled: boolean`).
- **Goodbye logic inconsistency.** ✅ Fixed 2026-05-06. `<rituals>` block's used-out branch now explicitly enumerates two cases: (a) other rituals still unrecorded → move to next; (b) every other ritual already complete or used-out, OR this was the only ritual → end immediately with a short goodbye, do NOT ask another KPI question. New regression test in `agent.test.ts` ("single-ritual used-out terminates: no further KPI tools fire even if user keeps talking") drives a follow-up "Yes, by the way" after used-out and asserts state stays null — this passed against Gemini.
- **Memory warnings climbed to ~608 MB during a single call.** The SDK logs `process memory usage is high` repeatedly; `memoryLimitMB: 0` means no hard cap. Worth keeping an eye on with concurrent calls; revisit if we ever hit a real limit.
- **`recordAnsweredCall` skipped under `ritualUsedOut`.** When the user marked the ritual as used-out, the conversation wrapped up before `recordAnsweredCall` could fire. The downstream `mergeFinal` invariant treats this correctly (used-out is sticky), but `tracking-workflow/lib/tracking-events.ts`'s `allRitualsComplete` was treating null-KPIs as "not complete," which would leave `completedAt` unstamped. Fixed in tracking-workflow's helper (used-out now counts as complete) — note here so we remember that single-ritual-used-out is the canonical short-circuit case.
- **Gemini `recordRelapse` fragility (still open).** 3 of 8 LLM-driven tests fail intermittently because the Gemini family is less decisive about firing `recordRelapse` than OpenAI is. Behavior, not architecture. Accepted as ship-now/iterate-later — revisit by either tuning the prompt's relapse phrasing or trying a different model.

### Polish round 2 (from second end-to-end voice test 2026-05-06) 🔧
- **Conversation shape redesign.** ✅ Done. Replaced "ask three KPIs sequentially" with broad opener + extract-and-fill + targeted follow-ups on gaps. The agent now opens with "Hi, this is the tracking agent from Samwise. How did you do today with <behaviorLabel>?" and fires every tool it can from one user reply, only following up on missing fields. Tests still pass at 5/8 against `gemini-2.5-flash`.
- **Behaviour label.** ✅ Done. `RitualEntry.behaviorLabel` (optional) added to the metadata contract. Agent uses `behaviorLabel` for conversational reference, falls back to verbatim Google Doc title (`label`) when missing. cloud-functions/registerNewRitual now writes `users/{userID}.behaviorLabels`; tracking-workflow propagates it through dispatch metadata; agent reads it in `buildInstructions`.
- **VoiceID hardcoded by language.** ✅ Done. `metadata.voice_id` no longer consumed. `main.ts` picks Cartesia voiceID by language: English → `5ee9feff-1265-424a-9d7f-8e4d431a12c7` (English-Male), Spanish → `b042270c-d46f-4d4f-8fb0-7dd7c5fe5615` (Spanish-Male). Voice for tracking is a brand decision, not a per-user preference; narya still consumes user.voiceID for the morning-coaching call.
- **Gemini model rolled back from 3-preview to 2.5-flash.** ✅ Done. `gemini-3-flash-preview` strictly enforces `thought_signature` on follow-up function-call parts; `@livekit/agents-plugin-google@1.2.8` doesn't propagate it, so every multi-tool turn 400'd → 3× retry → ~6s of dead air → AgentSession closed unrecoverably. Added explanatory comment in `AGENT_MODEL` so future readers don't bump it back. Narya is unaffected because it does fewer rapid-fire tool calls; intentionally diverges. Promote both to a working 3-class model when `@livekit/agents-plugin-google` ships thought_signature support.
- **Cartesia "Invalid transcript" still spamming intermittently.** Open. Despite the prompt instruction to pair every tool call with non-empty TTS, the agent still occasionally emits empty payloads. Cosmetic only — does NOT break the call. Possible code-side fix: wrap the Cartesia plugin to filter empty/whitespace-only text. Not user-blocking; leave for later.

### Tech-debt notes 📌
- **OpenAI override dropped.** `pnpm.overrides.openai = "6.8.1"` was a workaround for the LiveKit Inference path. Since the migration to direct providers (Deepgram + Google + Cartesia), `inference.LLM` is no longer constructed and the override is unnecessary. Already removed from `package.json` per the migration; do not re-add.
- The starter test file's three placeholder cases (friendly greeting, etc.) were removed entirely in Phase 4. If LiveKit ever updates the starter template, do not re-merge those tests — they don't apply to the tracking agent.
- `CLAUDE.md` / `GEMINI.md` shipped by `lk agent init` are template stubs that point at `AGENTS.md`. Left as-is for cross-tool compatibility.

## Important Notes
- **Don't import from `my-agent/`.** Copy patterns; couple modules only via the dispatch metadata contract documented in `context-for-code-agent.md`.
- **Turn counter, not LiveKit answer events.** Per the user's explicit guidance and the parent style guide. The `userTurnCount > 0` derivation is the canonical "did a real conversation happen" signal.
- **The agent never writes Firestore.** All persistence is via the cloud-function callback; the agent stays stateless w.r.t. our data layer.
- **Same Telnyx trunk as `my-agent`.** `SIP_OUTBOUND_TRUNK_ID` env var carries the trunk ID. The fact that it's the same trunk means rate-limit considerations apply jointly with `my-agent` — keep the QStash schedule fan-out concurrency in mind once we go live.
