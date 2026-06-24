# current-plan.md — Demo Call Agent (flows/demo-call)

> Status: **IMPLEMENTED, UNTESTED** (2026-06-01). Phases 1-9 built and compiling
> (ritual-agent `vite build` ✓, cloud-functions `tsc` ✓, samwise-app changed files
> type-clean). NOT yet run against a live call — testing is the next step.
> Deferred: the landing `/meet` audio-only-tile tweak, the `autonomous` flag on
> `/api/book/create`, real few-shot examples, step-level 5b granularity, and
> refining DEMO_EXTRACTION_PROMPT against real transcripts. Read alongside
> `context-for-code-agent.md` (same folder) and `../../programming-style.md`.

## Plan Summary

Build the **Demo Call Agent**: an autonomous LiveKit voice agent (a new
`flows/demo-call/` inside the `ritual-agent` worker) that runs the 50-min Demo
Call script with a prospect over WebRTC, with **no human rep**, driving the
prospect's existing `/meet` story-visual screen.

Decisions locked with the user (2026-06-01):
1. **Autonomous, solo** — no supervisor/takeover console.
2. **Voice + live story visuals** — audio-only agent; prospect watches `RitualStory`.
3. **Script lives in the Google Doc** — loaded uncached at call start; phase machine
   + spoken lines come from the Doc (same one `/copilot` reads). Persona/rules/few-shots
   are baked into the agent prompt; the words are not. Edit the Doc → next call changes,
   no redeploy.
4. **Write-only tools; no read-tools.** Everything the agent reads is pre-loaded into
   its prompt by the worker (no mid-call read round-trip = no added latency).
5. **Dynamic block, sliding window** (current + next 1-2 phases, `{{vars}}` filled),
   advanced by a write-only `enterPhase` signal.

Everything downstream of the agent already exists and is reused, not rebuilt: the
DataChannel contract (`samwise-app/lib/demo-call/broadcast.ts`), the variable +
`fit_state` `[CONDITION]` contract (`samwise-app/app/copilot/demo-call-config.ts`),
the Doc parser (`loadCallScript` CF), the qualification prefill (`loadQualification`
CF), and the prospect's `/meet` receiver + `RitualStory` (`samwise-landing`). The
closest code analog to mirror is `flows/qualification/` (web voice flow, live capture,
converse→extract, all lifecycle nets).

Hard constraints carried from the skills (do NOT re-derive): `gemini-2.5-flash` +
`thinkingBudget:0` via `makeQualificationLlm` (FallbackAdapter→OpenAI for empty
completions); `UNFILTERED_SAFETY_SETTINGS` (clinical content); tool args `.nullish()`
not `.optional()`; `preemptiveGeneration:false`; 10-min idle + **60-min wall-clock
hard cap**; `onEnter`→`generateReply`; verbal filler; `<audio-quality>` block;
spoken-output vocab blacklist (`paciente/recaída/terapia/clínico`); the three
admission-test scarcity beats; Voss beats (mirror+silence on money, accusation audit,
`¿Qué?/¿Cómo?` not `¿Por qué?`, Borrero dignity-exit); Reflect→Track→Align→Guide;
ONE question per turn; **Rule 8 — do not fabricate prospect-behaviour evidence**
(few-shot examples come from real call transcripts, not invention).

## Plan Architecture (Flow)

**Call start (worker, all at `entry` time — no LLM, no latency on the conversation):**
1. `loadCallScript(docUrl)` → structured phases (uncached). `script.ts` segments
   Phase 5b into its 9 steps and filters phases by `[CONDITION]` using current `fit_state`.
2. `loadQualification(prospect_email)` → prefill values → seed the variable state.
3. Build the **baked prompt** (persona/rules/phase-index/few-shots/audio-quality) +
   the **dynamic block** for Phase 1 (filled spoken options + current-phase tag +
   lookahead to Phase 1.5).
4. Start the `AgentSession` (Deepgram es / `makeQualificationLlm` / Cartesia es-female
   / Silero VAD / MultilingualModel; `preemptiveGeneration:false`). `onEnter`→
   `generateReply()` so the agent opens with the Phase 1 frame.

**During the call (write-only tools mutate worker state + screen; worker re-injects the block):**
- `setVariables(updates)` → update state; publish `demo-call:variable_update` for
  `userVisible` vars; rebuild the dynamic block (refresh substitutions) → `updateChatCtx`.
- `showVisual(stage)` → publish `demo-call:show_visual`.
- `enterPhase(phaseId)` → set current phase; rebuild block (current + lookahead,
  filtered by `fit_state`) → `updateChatCtx`. (Once `fit_state` is captured at 8.5,
  the lookahead follows the 9-15 vs 16-17 branch.)
- `endCall()` → terminal.

**Call end (converse→extract):** `submitIfNotYet(reason)` (idempotent; four triggers:
`endCall` / `ParticipantDisconnected` / `idle_timeout` / `hard_cap`) POSTs the
transcript (+ live state as a prior) to **`extractDemoCall`** — the single unified
demo-persistence CF (the human `/copilot` Save button routes through it too; Phase 9) →
authoritative `demoCalls/` record. Live capture drove UX/branch/substitution; the
extractor produces the record.

## Plan Structure (Directories and files)

New: `src/flows/demo-call/{index,agent,script,dynamicBlock,broadcast,variables}.ts`
and `prompts/{persona,demo-call-prompt}.ts`. Modified: `src/types/metadata.ts`,
`src/main.ts`. Reused unchanged: `config/providers.ts`, `services/drive.ts`,
`flows/onboarding/idleHandler.ts`, `flows/qualification/stallRecovery.ts`,
`config/voiceIds.ts` (reuse `QUALIFICATION_VOICE_ID_BY_LANGUAGE`). Cross-repo: extend
`samwise-app/app/api/walk-in/init` (add one `createAgentDispatch` for autonomous
bookings) + a small `samwise-landing` `/meet` receiver tweak; a new `extractDemoCall`
cloud function in `samwise-backend/cloud-functions` (the unified demo-persistence CF);
and migrating the `/copilot` Save button (`samwise-app/lib/copilot/append-row.ts`) onto it.

---

## Modifications (in phases and steps)

### Phase 1 / Step 1 — Register the flow in the router

- **In-file location:** `src/types/metadata.ts`.
- **Should not be modified:** `CallMeta`, `OnboardingMeta`, `QualificationMeta`, and the
  existing branches of `parseDispatchMetadata` (incl. the legacy `flow → 'call'` default).
- **Code:** add the interface, the union member, and a parse branch (place BEFORE the
  trailing `call` default):
  ```ts
  // DemoCallMeta — web autonomous Demo Call. Dispatched by the demo-call init
  // route after a booking. prospect_email hydrates the qualification prefill
  // server-side at call start; script_doc_url lets the Doc be overridden per env.
  export interface DemoCallMeta {
    flow: 'demo-call';
    language: Language;
    prospect_name: string;
    prospect_email: string;
    script_doc_url: string;
  }
  // ...add to the union:
  export type DispatchMeta = CallMeta | OnboardingMeta | QualificationMeta | DemoCallMeta;
  // ...inside parseDispatchMetadata, before the final `return { flow: 'call', ... }`:
  if (flow === 'demo-call') {
    return {
      flow: 'demo-call',
      language,
      prospect_name: String(m.prospect_name ?? '').trim() || 'friend',
      prospect_email: String(m.prospect_email ?? '').trim(),
      script_doc_url: String(m.script_doc_url ?? ''),
    };
  }
  ```
- **Explanation:** discriminated-union + default-missing-to-`''` parsing, exactly like
  the other flows. `script_doc_url` defaults handled in `script.ts` (fall back to the
  canonical Doc id if blank).

### Phase 1 / Step 2 — Route to the flow

- **In-file location:** `src/main.ts`.
- **Should not be modified:** `BUILD_TAG` mechanism (but DO bump it on deploy),
  `prewarm`, `cli.runApp`, the existing `case`s.
- **Code:** add the import and the case:
  ```ts
  import { runDemoCallFlow } from './flows/demo-call';
  // ...inside switch (meta.flow):
  case 'demo-call':
    return runDemoCallFlow(ctx, meta);
  ```
- **Explanation:** one line in the thin router; no DevOps surface added (one deploy,
  one secret set).

### Phase 2 / Step 1 — The demo-call variable set

- **In-file location:** NEW `src/flows/demo-call/variables.ts`.
- **Code:** a worker-side mirror of `samwise-app/app/copilot/demo-call-config.ts`'s
  `DEMO_CALL_VARIABLES` — at minimum each variable's `name`, `userVisible`, and a
  one-line `meaning` (for the prompt). Keep `fit_state` (`qualified|still_disqualified`,
  default `qualified`) and the `behaviour_to_change` (short clause) vs `behaviour_example`
  (full incident) split. Export `USER_VISIBLE_NAMES` (the 7) for the broadcaster.
- **Should not be modified:** the app-side config is the source of truth — this is a
  MIRROR (note it at the top of the file, like `flows/qualification/schema.ts`).
- **Explanation:** the agent needs the variable list to know what to capture and which
  to broadcast. Mirror, don't re-invent; cross-repo drift rule applies.

### Phase 2 / Step 2 — Port the broadcaster to the worker

- **In-file location:** NEW `src/flows/demo-call/broadcast.ts`.
- **Code:** port `samwise-app/lib/demo-call/broadcast.ts` to the agent runtime. Same
  wire shapes (`demo-call:variable_update` / `demo-call:show_visual`, `reliable:true`),
  but publish via the agent's `ctx.room.localParticipant.publishData(...)` (the
  qualification `setVariables.execute` pattern). Export `publishVariableUpdate(room,
  name, value)`, `publishVisual(room, stage)`, `publishSnapshot(room, state)` and the
  `StoryStage` union. Wrap each publish in try/catch (publish racing shutdown is normal).
- **Should not be modified:** the prospect-side receiver in `samwise-landing` — it
  already decodes by `type`. **Do not rename the `demo-call:*` event namespace.**
- **Explanation:** this is the ONLY change needed on the realtime path — the transport,
  visuals, and receiver already exist; the agent just becomes the publisher.

### Phase 3 / Step 1 — Load + index the script

- **In-file location:** NEW `src/flows/demo-call/script.ts`.
- **Code:** `loadDemoScript(docUrl)` → POST to `loadCallScript`
  (`https://loadcallscript-b6fhjlgejq-uc.a.run.app`, `cache:'no-store'` + cache-buster,
  exactly like `samwise-app/lib/copilot/load-script.ts`). Then build an ordered
  `Phase[]` where each phase has `{ id, title, goal (note text), sayBlocks: string[]
  (raw, with {{var}}), captureVars: string[], condition?: {var,value} }`. **Segment
  Phase 5b** into its 9 steps by its `#### Step N` sub-headers. Provide
  `visiblePhases(phases, state)` that drops phases whose `[CONDITION: var=value]`
  doesn't match `state` (reuse the copilot's `parsePhaseCondition` logic).
- **Should not be modified:** the Doc, the `loadCallScript` CF (single shared parser).
- **Explanation:** "live from the Doc" — the script is fetched per call so Doc edits
  propagate with no redeploy; the worker (not the LLM) does the fetch at start →
  zero conversational latency. `[CONDITION]` filtering = the `fit_state` branch.

### Phase 4 / Step 1 — The dynamic-block builder

- **In-file location:** NEW `src/flows/demo-call/dynamicBlock.ts`.
- **Code:** `buildDynamicBlock({ phases, currentPhaseId, state, lookahead = 2 })` →
  an XML string the worker injects as a dedicated system message. Substitute
  `{{name}}` in each spoken block from `state` (leave unfilled ones as `{{name}}` so
  the agent knows to capture). Shape:
  ```xml
  <current-phase>
    <id>5b-step-5</id>
    <title>Phase 5b · Step 5 — Intention (IFS reframe)</title>
    <goal>…the note-block guidance for this step, verbatim from the Doc…</goal>
    <say-options>…the phase's spoken blocks, {{vars}} substituted…</say-options>
    <capture>intention_behind_action — via the IFS reframe; NEVER the direct "¿qué buscabas?"</capture>
    <on-advance>call enterPhase("5b-step-6") once captured</on-advance>
  </current-phase>
  <next-phases-preview>…the next 1-2 visible phases, filled…</next-phases-preview>
  ```
- **Should not be modified:** the substitution must never alter spoken wording beyond
  filling slots (live-from-Doc fidelity).
- **Explanation:** this is "the script in front of the rep." The agent reads its lines
  here, pre-filled; lookahead means it's never stalled waiting on the worker even
  across the `enterPhase` round-trip.

### Phase 5 / Step 1 — Baked prompt (persona + rules + structure)

- **In-file location:** NEW `src/flows/demo-call/prompts/persona.ts` and
  `prompts/demo-call-prompt.ts`. XML-tagged (per programming-style §1.A).
- **Code:** `buildDemoCallPrompt(language, phasesIndex)` returns the static instructions:
  `<persona>` (Carolina-Borrero centered-clinician — sourced from before-the-call §3b),
  `<hard-rules>` (ONE question/turn; spoken-output vocab blacklist; never speak clinical
  terms though you may reason in them; `¿Qué?/¿Cómo?` not `¿Por qué?`; frame→action not
  slogan; body-language-as-voice / Late-Night-DJ delivery at the scarcity beats),
  `<listening>` (Reflect→Track→Align→Guide), `<scarcity>` (the three `evaluar` beats —
  Phase 1 frame, Phase 8.5 pause, Phase 11 verdict; run all or none; danger-zones list),
  `<money>` (mirror+silence → calibrated diagnose → constraint-targeted response /
  Borrero exit; accusation audit at Phase 10), `<phases-index>` (the ordered phase list
  + the `fit_state` branch, so the agent has the map), `<tools>` (when to call
  setVariables/showVisual/enterPhase/endCall), `<audio-quality>` (bad-mic protocol),
  and `<conversation-examples>` (one full close + one disqualified-rebound).
- **Should not be modified — and a hard rule:** the `<conversation-examples>` must be
  built from **real call transcripts**, NOT invented (samwise-script-work Rule 8).
  **No transcripts exist yet (confirmed 2026-06-01) → ship `[REP IMPROVISES — phase
  goal: X]` skeletons, not fabricated dialogue.** Backfill real close + rebound examples
  once the first agent calls (or human demos) are recorded.
- **Explanation:** the baked prompt holds *who the agent is and how it behaves*; the
  *words it says* come from the Doc via the dynamic block — so the two never duplicate
  or drift. Place the metaphor/vocab guardrail LAST (recency).

### Phase 6 / Step 1 — The agent class + write-only tools

- **In-file location:** NEW `src/flows/demo-call/agent.ts`.
- **Code:** `class DemoCallAgent extends voice.Agent`, mirroring
  `flows/qualification/agent.ts` (module-level Zod schemas with every field `.nullish()`
  + `.describe()`; tools defined inline in `super({...})`; per-agent state in the
  constructor closure). Tools (ALL write-only, minimal acks):
  - `setVariables(updates)` — for each non-blank value: update worker state (via an
    injected `onSetVar` callback), publish `demo-call:variable_update` if `userVisible`,
    return `{ committed }`. The agent is instructed to capture **already-clean,
    script-fit values** (no live `cleanVariable`).
  - `showVisual({ stage })` — `publishVisual(room, stage)`; return `{ ok: true }`.
  - `enterPhase({ phase_id })` — invoke an injected `onEnterPhase(phaseId)` callback
    (the worker rebuilds the block + `updateChatCtx`); return `{ ok: true }`.
  - `endCall()` — idempotency-guarded; fires injected `onEndCall`; returns `{ ok: true }`.
  - `override async onEnter() { this.session.generateReply(); }` (no `await`).
- **Should not be modified:** keep tools write-only — do NOT add a `getScript` /
  `getVariable` read-tool (latency; violates the locked principle).
- **Explanation:** the agent talks + signals; the worker owns all read-context. Closure
  state per dispatch (worker process is reused).

### Phase 7 / Step 1 — The orchestrator

- **In-file location:** NEW `src/flows/demo-call/index.ts` (`runDemoCallFlow(ctx, meta)`).
- **Code (mirror `flows/qualification/index.ts` closely):**
  1. `await ctx.connect()`.
  2. `const script = await loadDemoScript(meta.script_doc_url)`.
  3. `const prefill = await loadQualification(meta.prospect_email)` → seed `state`
     (handle not-found gracefully — Phase 5b Step 1 fallback + thin Phase 1.5).
  4. Closure state: `let state = {...prefill}`, `let currentPhaseId`, `let submitted=false`,
     `let userTurnCount=0`. Define `rebuildBlock()` → `agent.updateChatCtx(...)` swapping
     the single dynamic system message; `onSetVar`, `onEnterPhase` mutate `state`/
     `currentPhaseId` then `rebuildBlock()`.
  5. `new voice.AgentSession({ stt: makeStt(meta.language), llm:
     makeQualificationLlm(UNFILTERED_SAFETY_SETTINGS), tts: makeTts(meta.language,
     QUALIFICATION_VOICE_ID_BY_LANGUAGE[meta.language]), turnDetection: new
     MultilingualModel(), vad: ctx.proc.userData.vad, preemptiveGeneration: false })`.
     Voice reuses the qualify table (`config/voiceIds.ts` —
     `QUALIFICATION_VOICE_ID_BY_LANGUAGE`, es = `13ff5deb-2591-42ad-a356-63a04e524411`)
     per the user's call (2026-06-01); no new voice ID.
  6. Lifecycle (reuse verbatim): `attachIdleShutdown(ctx, session, 10*60*1000)`; a
     **60-min** `HARD_MAX_SESSION_MS` timer (the demo runs ~50 min — do NOT copy
     qualification's 25-min cap; it would kill a 50-min call mid-way) →
     `submitIfNotYet('hard_cap')` then
     `ctx.shutdown`; `attachStallRecovery`; verbal-filler on `thinking`; `userTurnCount`
     on `ConversationItemAdded`; `ParticipantDisconnected` → `submitIfNotYet('disconnect')`.
  7. `publishSnapshot(ctx.room, state)` once the prospect is present (prefilled notes
     show before the agent edits anything).
  8. `submitIfNotYet(reason)` — idempotent; build transcript from `agent.chatCtx.items`;
     POST to the extractor (Phase 9).
  9. `await session.start({ agent, room: ctx.room, inputOptions: { noiseCancellation:
     BackgroundVoiceCancellation() } })`.
- **Should not be modified:** the reused helpers (`idleHandler`, `stallRecovery`).
- **Explanation:** this is the qualification orchestrator with demo-call state +
  block-rebuild wiring added; every lifecycle net is carried over.

### Phase 8 / Step 1 — Dispatch the agent into the booking room  *(cross-repo)*

- **How a call actually starts (corrected — no cal.com):** the prospect books via
  `samwise-landing/app/book/` → `/api/book/create` writes a Google Calendar event +
  `calendarBookings/{calEventId}` (carrying `roomName`, `prospect {name,email}`,
  `language`). The email link opens `samwise-landing/app/meet/[id]`, which calls
  **`samwise-app/app/api/walk-in/init`** (`mode:'join_existing', side:'user'`) to mint
  the prospect token for `booking.roomName`. (Walk-ins take the `mode:'create'` path of
  the same route.) The prospect-facing receiver — `RitualStory` + the `demo-call:*`
  subscriber — is `samwise-landing/app/meet/call-room.tsx`.
- **Integration (supersedes the earlier "new samwise-landing route" idea — reusing the
  existing route is cleaner):** extend `samwise-app/app/api/walk-in/init` so that, on the
  prospect-join path of an **autonomous** booking, it also calls
  `createAgentDispatch({ agentName:'ritual-agent', roomName: booking.roomName, metadata:
  { flow:'demo-call', language: booking.language, prospect_name: booking.prospect.name,
  prospect_email: booking.prospect.email, script_doc_url: DEFAULT_DEMO_SCRIPT_DOC_URL } })`
  — and does NOT mint a human-therapist token. Dispatch once per room.
- **Small frontend tweak:** the prospect `/meet` receiver assumes a human on the other
  side — for an audio-only agent there is no therapist video track, so suppress/replace
  the empty therapist tile (the agent is voice + `RitualStory` only). Minimal change to
  `samwise-landing/app/meet/call-room.tsx`.
- **Should not be modified:** `RitualStory`, the `demo-call:*` receiver decoding,
  `lib/livekit-dispatch.ts`, the booking resolution in `walk-in/init`. `runtime='nodejs'`.
- **Open detail to confirm at build:** exactly how an "autonomous" booking is flagged
  (a field on the `calendarBookings`/`walkIns` doc vs a separate booking type) and
  whether `/api/book/create` sets it. Gating it lets Samuel still run a demo manually.
- **Explanation:** the room, the token mint, the booking resolution, and the receiver all
  exist — the only missing piece is putting the agent in the room, which is one
  `createAgentDispatch` call added to the existing route.

### Phase 9 / Step 1 — Unified persistence via `extractDemoCall`  *(decided: one method, the better one)*

- **The unification (your call, 2026-06-01):** `extractDemoCall` is the single canonical
  demo-persistence CF — the more complete method (full transcript re-extraction), NOT
  bounded by the existing `appendDemoCallRow`. BOTH the autonomous agent AND the human
  `/copilot` "Save call" button route through it → one write path, one `demoCalls` shape.
- **New CF `extractDemoCall`** in `samwise-backend/cloud-functions` (mirror
  `extractQualification`), dual-input:
  - **Transcript mode (agent; later any transcribed demo):** `{ transcript, liveState,
    prospect_email }` → re-extract the full demo variable set with
    `responseMimeType:'application/json'` (liveState as a prior), persist the transcript
    on the doc (enables backfill), write `demoCalls/{prospectKey}-{ts}`.
  - **Rep-state mode (human copilot today — no transcript):** `{ raw, cleaned,
    qualificationProspectKey }` → normalize + write the same shape (what
    `appendDemoCallRow` does now).
  Always writes the SAME `demoCalls` doc shape (`repName`, `outcome`, raw, cleaned,
  prospectKey, createdAt — match the current one) so downstream readers don't change.
- **Migrate the copilot button:** point `samwise-app/lib/copilot/append-row.ts` at
  `extractDemoCall` (rep-state mode); retire `appendDemoCallRow` (or leave it a thin
  alias to avoid churn). Set `repName = "Samwise Agent"` on agent-run rows so `demoCalls`
  distinguishes agent vs human demos.
- **Agent side:** at end-of-call `submitIfNotYet` POSTs `{ transcript, liveState,
  prospect_email }` to `extractDemoCall` (`EXTRACT_DEMO_CALL_URL` secret). Live captures
  drove the call; the extractor produces the record.
- **Forward direction (noted, not now):** once human demos are also transcribed
  (agent-observability / passive STT in the human room), the human path uses transcript
  mode too → extraction is uniform for every demo. Rep-state mode is the bridge until
  then (and moot once the agent is the primary rep).
- **Should not be modified:** the `demoCalls` doc shape (downstream readers depend on it).
- **Explanation:** unifies persistence on the more complete method (transcript
  extraction) while keeping the live path latency-free (no mid-call persistence/cleaning).

### Deferred sub-phases (flagged; not in the first build) — open product decisions

- **Phase 12 close actions** (send payment link, book the next session live): needs a
  write tool (e.g. publish a link to the screen and/or trigger an email) AND the
  payment + booking mechanics decided. Side-effectful — confirm with the user.
- **Phase 5a/8 live Samwise Ritual Doc** (create + share a Doc during the call): a
  `createRitualDoc`-style tool (a `createritualdoc` CF exists). Defer.
- **Declined this round:** supervisor/takeover console; rep avatar/video.

### Testing phase

- **Local test:** `pnpm dev` in `ritual-agent` with `.env.local` (incl. `GOOGLE_API_KEY`,
  `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `OPENAI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`,
  `EXTRACT_DEMO_CALL_URL`). Dispatch a `flow:'demo-call'` job (a small script or the new
  init route locally) and join from the `/meet` receiver. Verify in logs (bump
  `BUILD_TAG`; view unfiltered): the script loaded, prefill hydrated, the agent opened
  with the Phase 1 frame, `enterPhase`/`setVariables`/`showVisual` fired, the dynamic
  block updated, NO English reasoning leaked into TTS, no dead-air-after-tool, idle/hard
  caps armed.
- **Integration test:** confirm on the prospect screen the `RitualStory` stage changes
  on `showVisual` and the variable cards fill on `setVariables`; confirm the `fit_state`
  branch (force `still_disqualified` → the agent runs Phases 16-17, not 9-15); confirm
  `demoCalls/` got the record at end-of-call.
- **Eval (recommended before relying on it):** dispatch a few synthetic prospects
  (vary identification depth incl. a businessman-shallow case) and read transcripts for
  vocab-blacklist leaks, scarcity-beat coverage, re-asks of prefilled data, and correct
  8.5 classification. (Ties into the OBSERVABILITY / EVALS tasks in the Vibe doc.)
- **Update README:** add the `demo-call` flow + its secrets to `ritual-agent/README.md`.

### After implementation

- Update `src/flows/demo-call/context-for-code-agent.md` (Module Structure → actual
  files; note any deviations).
- Update `ritual-agent/context-for-code-agent.md` (add `flows/demo-call/` to the Module
  Structure tree + the "three flows" → "four flows" wording).
- Add `EXTRACT_DEMO_CALL_URL` (+ confirm `OPENAI_API_KEY`) to the deployed agent secrets
  (`lk agent update-secrets`), bump `BUILD_TAG`, deploy, read the tag back from an
  unfiltered session log.
- Mark **DEMO CALL AGENT** done in the master Vibe doc Projects tab (manual user step).
