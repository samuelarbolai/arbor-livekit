# Code Agent Context for Arbor Livekit Cloud Functions

## Parent Project Overview
This context file describes the cloud-functions module of the `samwise-backend` project. The module is a Firebase Cloud Functions (TypeScript, v2) backend that drives the "ritual" product loop: users define a ritual in a Google Doc, the backend extracts a structured config from it via Gemini, persists it in Firestore, and a scheduler later dispatches a LiveKit voice agent to place an outbound SIP call to the user at the configured time.

## Parent Project Architecture (Flow)
1. **Ritual registration (HTTP):** The frontend POSTs a Google Doc link + a Gemini instruction prompt. The function fetches the doc, asks Gemini to extract a `RitualData` JSON, and writes/updates a `rituals` document in Firestore.
2. **Scheduled rituals check (cron):** Every 30 minutes, in `America/Bogota` time, build a `DAY_HH:MM` schedule key for "now" and look up rituals whose `schedules` (or `fallbackSchedules` with `fallback_active=true`) contain that key. POST the resulting userIDs to the dispatch HTTP function.
3. **Batch call dispatch (HTTP):** Given a list of userIDs, load each ritual from Firestore and create one LiveKit `AgentDispatch` per ritual. The dispatched agent ("my-agent") places the actual outbound SIP call.
4. **Identity canonicalization at create time:** When creating a brand-new ritual, lookup by `userID` then `phoneNumber` to attach the new ritual to an existing user's canonical identity. A user may own many rituals (one per Google Doc); ritual dedup is done by `googleDocId`, not by user.

## Parent Project Modules
The cloud functions live entirely in:
- `samwise-backend/cloud-functions/functions/src/`
  - `index.ts` — All exported cloud functions (single-file module).
  - `package.json` — Dependencies and scripts.
  - `tsconfig.json` — TypeScript compiler config.
  - `.env` — Environment variables (loaded via `dotenv/config`).
  - `node_modules/` — Installed dependencies.
  - `context-for-code-agent.md` — This file.
  - `current-plan.md` — Active plan tracking.
  - `programming-style.md` — Style guide for this module.

## Module Overview
`index.ts` exports the following cloud functions:

**Ritual loop:**
- **`helloWorld`** (HTTP) — Sanity check endpoint.
- **`registerNewRitual`** (HTTP) — Reads a Google Doc, extracts ritual data via Gemini, and creates or updates a `rituals` document. Dedup key is the Google Doc ID extracted from the URL.
- **`createRitualDoc`** (HTTP) — Copies a canonical template Doc into a shared Drive folder, patches the Metadata tab with the operator's inputs, returns the new Doc URL.
- **`checkUsersRituals`** (Scheduled, every 30 min, `America/Bogota`) — Builds a `DAY_HH:MM` schedule key for "now" and queries `rituals` for matches on `schedules` and on `fallbackSchedules` (with `fallback_active=true`). Hands off the userIDs to `makeCallsBatchFunction` over HTTP.
- **`makeCallsBatchFunction`** (HTTP) — Given a JSON array of userIDs, loads each ritual from Firestore and creates one LiveKit agent dispatch per ritual. Uses fire-and-forget-error batching so one failed call does not abort the rest.

**Session Copilot** (backing the `/copilot` route in samwise-app — see `samwise-session-copilot` skill):
- **`loadCallScript`** (HTTP) — Reads a script Google Doc, parses it deterministically via `parseScript()` into `{ scriptType, version?, phases: [{ number, title, blocks: [{ kind: "say" | "note", text }] }] }`. No LLM in the loop — uses `[TYPE: ...]` + optional `[VERSION: ...]` + `Phase N — title` headings (whitespace required around the dash) + `[SAY]/[/SAY]` body markers as exact tokens. `[END]` line terminates the renderable script (anything after — variable refs, changelog — is dropped). Default function timeout (Drive read is the only slow path).
- **`cleanVariable`** (HTTP) — Per-field denoising of a rep's mid-call raw note. Body includes `frameworkSemantics` (per-variable extract/ignore rules) and `scriptContexts` (the actual sentences where the variable will be substituted). Returns one phrase that fits all the slots. Returns 200 even on error (falls back to `rawValue`) so the frontend never blocks the rep on a failed cleaning.
- **`appendDemoCallRow`** (HTTP) — Appends one row to the funnel sheet's `"Demo call"` tab via the Sheets API. Column order is duplicated between this function's `DEMO_CALL_COLUMNS` and the frontend's `FUNNEL_SHEET_COLUMNS`; drift between them lands cells in wrong columns.

The new tracking feature lives entirely in sibling modules (`tracking-agent/`, `tracking-workflow/`). This module has no responsibilities in the tracking loop — see `samwise-backend/tracking-workflow/context-for-code-agent.md`.

## Module Structure (Directories and files)
```
samwise-backend/cloud-functions/functions/src/
├── index.ts                       # All exported cloud functions
├── context-for-code-agent.md      # This file
├── current-plan.md                # Active plan tracking
├── programming-style.md           # Style guide for this module
├── google-doc-template.md         # Canonical structure for the ritual Doc tabs
├── ritual_synthesis_prompt.txt    # Gemini prompt for registerNewRitual
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript configuration
├── .env                           # Local environment variables
└── node_modules/                  # Installed dependencies
```

## Module Files
### File Purpose
- **index.ts**: Single-file module exporting all four cloud functions. Initializes Firebase Admin once, holds a module-level Firestore handle (`db`), and uses `cors` for the registration endpoint.
- **context-for-code-agent.md**: This file — module-level context for the code agent.
- **current-plan.md**: Active implementation plan with phase tracking.
- **programming-style.md**: Cloud-function-specific style patterns (defensive batching, O(1) string-key scheduling, scoped interface declaration, lazy singletons).
- **google-doc-template.md**: Canonical structure for the three-tab Google Docs that drive `registerNewRitual` (`Problem - Solution`, `Coach Call`, `Metadata`).
- **ritual_synthesis_prompt.txt**: The hardcoded Gemini prompt for `registerNewRitual`. Loaded at module load by `fs.readFileSync`; copied into `lib/` by the build script. Edits to this file are governed by the `ritual-synthesis-prompt` skill at `samwise/.claude/skills/ritual-synthesis-prompt/SKILL.md`.
### Recent Changes
- **2026-05-26 (later)**: Tightened `parseScript()` after first-deploy bug reports. Three changes: (1) `PHASE_RE` now requires whitespace on BOTH sides of the dash separator — distinguishes real headings (`Phase 1 — Set validations`) from range notation in meta lists (`Phase 5–8: thoughts_during_relapse, ...` previously matched as Phase 5 with title "8: thoughts..."). (2) `PRECALL_RE` / `POSTCALL_RE` now use `(?!:)` negative lookahead — rejects `Pre-call: prospect_name, ...` / `Post-call: outcome, ...` pseudo-headings that appear in the variable reference. (3) Added `[END]` line as a script terminator — anything after is dropped, regardless of regex match. Also added `[VERSION: x.y]` extraction near the Doc top, surfaced as an optional `version` field on the response. The Demo Doc now carries `[VERSION: 0.4]` at the top and `[END]` after Phase 17. Frontend renders the version as a small chip in the script pane top-right. Backwards compatible: missing `[VERSION]` / `[END]` leave behavior unchanged.
- **2026-05-26**: `loadCallScript` lost its Gemini dependency. The previous parse round-trip (`gemini-2.5-flash`, ~5–15s, 120s timeout) was doing no real reasoning — the prompt instructed Gemini to treat `[SAY]/[/SAY]` as deterministic markers. Replaced with a pure-TS `parseScript(title, content)` exported from `index.ts`. Convention triple: optional `[TYPE: demo|onboarding|call_design]` line near the top of the Doc (authoritative; keyword fallback for older Docs), `Phase N — title` / `Phase N.M — title` / `Pre-call …` / `After the call …` / `Post-call …` headings (em-dash, en-dash, or hyphen accepted; phases emitted in DOCUMENT order — the Demo Doc puts "After the call" between Phase 12 and Phase 13), and `[SAY]/[/SAY]` body tokens. Output JSON shape is byte-identical to the previous Gemini output, so the frontend, the localStorage v2 sessions, and the script-pane renderer required zero changes. The `LOAD_SCRIPT_PROMPT` constant, the `load_call_script_prompt.txt` file, the build-time `cp` step in `package.json`, and the `timeoutSeconds: 120` override are all removed. Function URL hash unchanged (`loadcallscript-b6fhjlgejq-uc.a.run.app`). New latency: ~1–3s (Drive read only). Limitation: trailing non-phase content after the last phase heading (e.g. the "Quick variable reference" meta section after Phase 17 in the Demo Doc) gets absorbed into that last phase's body — same behavior as Gemini-era runs. If this becomes noisy in practice, add an explicit `[END]` line at the script author's discretion and extend `matchPhaseHeading` to recognize it as a closing sentinel.
- **2026-05-18**: Session Copilot landing — added three new HTTP exports backing `/copilot` in samwise-app: `loadCallScript` (Drive read + Gemini parse into phases-of-blocks; uses `[SAY]/[/SAY]` markers), `cleanVariable` (per-field script-context-aware denoising; accepts `frameworkSemantics` + `scriptContexts`; falls back to `rawValue` on error), `appendDemoCallRow` (Sheets API append to funnel sheet `Demo call` tab). New `load_call_script_prompt.txt` loaded alongside the existing synthesis prompt; the build script was extended to copy it into `lib/`. Added `https://www.googleapis.com/auth/spreadsheets` scope to the existing `getGoogleAuth` singleton and added a `getSheetsClient` lazy-singleton next to the existing Drive/Docs clients. `loadCallScript` has `timeoutSeconds: 120` because the default 60s wasn't enough for the cold-start + Gemini Pro path before we switched it to Flash. The funnel sheet (`1YS0ZVjB3rZK_AZKMeCbBbD__Mvz91lWXAqHcIBt0Cmw`) must have the service account from `GOOGLE_APPLICATION_CREDENTIALS` shared as Editor for `appendDemoCallRow` to succeed (manual one-time ACL step). `DEMO_CALL_COLUMNS` in this file is the canonical column order for the sheet write — it MUST stay in sync with `FUNNEL_SHEET_COLUMNS` in `samwise-app/app/copilot/demo-call-config.ts` or rows land in wrong columns. See `samwise-session-copilot` skill for full architecture rationale.
- **2026-05-04**: Tracking loop scope explicitly reverted out of this module. Earlier in the day a Phase 5 was drafted here adding `dispatchTrackingCall` and `trackingCallback` endpoints, plus `users` / `trackingEvents` collection definitions. That split was wrong — both endpoints had no real reason to live in Firebase rather than alongside the orchestration on Vercel, and putting them here added two unnecessary HTTP hops (workflow → Firebase → LiveKit, agent → Firebase → workflow) when a direct Vercel path is one hop each. The whole tracking feature now lives in `samwise-backend/tracking-workflow/` (Vercel) plus `samwise-backend/tracking-agent/` (LiveKit Cloud). This module is unchanged and stays focused on the ritual loop.
- **2026-05-01**: SKILL.md compliance pass for the synthesis prompt. Worked example rewritten as the Rule 9 JSON envelope (the XML and UNMAPPED MATERIAL are JSON-escaped inside `userInputs`; schedules array exercises Rule 10 via the example's "Daily at 1pm" timing). Final recency-bias reminder for Rule 2 added before `RAW MATERIAL TO PROCESS:`. Prompt moved out of `index.ts` into `ritual_synthesis_prompt.txt`, loaded via `fs.readFileSync` at module load; `build` script copies the .txt to `lib/` so `__dirname` resolution works at runtime. The `ritual-synthesis-prompt` skill is installed at `arbor/.claude/skills/ritual-synthesis-prompt/SKILL.md` and references the new file paths. Language injection deliberately uses the raw value from the Metadata tab — therapists write the language name (e.g., "English") directly there, no code-side mapping.
- **2026-05-01**: Hardcoded synthesis prompt + metadata tab data model. Request body shrank to `{ googleDocLink }` only. Each ritual Google Doc now has three tabs (`Problem - Solution`, `Coach Call`, `Metadata`) per `google-doc-template.md`. Metadata tab is parsed in-process (regex per key; no LLM) for `userID` / `voiceID` / `language` / `phoneNumber` / `timeZone`. Synthesis prompt (caller-authored) is verbatim except Rule 9 (rewritten to a JSON envelope: `{ userInputs, schedules, fallbackSchedules }`) and a new Rule 10 (deterministic `DAY_HH:MM` schedule extraction with explicit day codes and half-hour boundary). Metadata `language` is also injected as an explicit `[NOTE: ...]` line at the end of the raw material so the synthesis prompt's Rule 1 has a canonical signal. `fallbackActive` is hardcoded `false`.
- **2026-05-01**: All `registerNewRitual` error responses converted to `{ error: "<message>" }` JSON shape (status codes unchanged) so the frontend can parse success and error paths uniformly. Scope limited to `registerNewRitual`; `makeCallsBatchFunction` is cron-only and was intentionally left as plain-string error bodies.
- **2026-05-01**: Added `userInputs` to the success response of `registerNewRitual` in both branches (UPDATE and CREATE) so the frontend can render what Gemini extracted.
- **(Prior)**: Added `googleDocId` as the canonical dedup key for `registerNewRitual` (extracted from the URL, invariant to query/fragment), with `googleDocsLink` kept as a display field. Switched the function from create-only to upsert: a hit on `googleDocId` triggers UPDATE preserving the existing `userID`; a miss triggers CREATE with userID/phone canonicalization.
- **(Prior)**: Implemented `registerNewRitual`, `checkUsersRituals`, `makeCallsBatchFunction`, and `helloWorld`.

## Data Management
### Firestore — `rituals` collection
One document per Google Doc (one ritual per doc). Fields:
- `userID: string` — Canonical user identity. A user may own many rituals.
- `googleDocId: string` — Dedup key, extracted from the Google Doc URL.
- `googleDocsLink: string` — Original URL as received (display only).
- `schedules: string[]` — `DAY_HH:MM` slot keys, e.g. `["MON_21:30", "WED_07:00"]`.
- `fallbackSchedules: string[]` — Alternate slots, only fire when `fallbackActive` is true.
- `fallbackActive: boolean` — Toggle for fallback slots.
- `timeZone: string` — IANA tz, e.g. `"America/Bogota"`.
- `agentConfig: { language: string, phoneNumber: string, userInputs: string, voiceID: string }` — Dispatch-time config. Note `voiceID`/`userInputs` here vs. dispatch-time `voiceId`/`userInput` in `makeCallsBatchFunction`'s `AgentConfig` interface.

### Schedule key format
`<DAY>_<HH:MM>`, day uppercased and time rounded to the half-hour boundary. Example: `MON_21:30`. Built with `Intl.DateTimeFormat` in the cron's timezone, then matched against `schedules` / `fallbackSchedules` via Firestore's `array-contains`.

## Environment Variables
Loaded via `dotenv/config`:
- `GOOGLE_APPLICATION_CREDENTIALS` — Hard-coded path to Firebase service account credentials. Same Firebase project, so no extra service-account auth is needed at runtime.
- `GEMINI_KEY` — API key for the Gemini model used in `registerNewRitual`.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — LiveKit credentials for `makeCallsBatchFunction`'s `AgentDispatchClient`.

## Third-Party Integrations
- **Firebase Admin** (`firebase-admin/app`, `firebase-admin/firestore`) — App init and Firestore handle.
- **Firebase Functions v2** (`firebase-functions/https`, `firebase-functions/v2/scheduler`) — `onRequest` and `onSchedule`.
- **Google Generative AI** (`@google/generative-ai`) — Gemini model calls. Currently `gemini-2.5-flash` with `responseMimeType: "application/json"`.
- **LiveKit Server SDK** (`livekit-server-sdk`) — `AgentDispatchClient.createDispatch` for outbound calls.
- **cors** — Wraps the `registerNewRitual` handler so the v0/Vercel frontend can call it from the browser.

## Style Reference
See `programming-style.md` for the patterns this module follows. Key idioms:
- **Defensive "Fire-and-Log" Batching** — Per-call `.catch` inside `Promise.all(map(...))` so one failure does not abort the batch.
- **O(1) String-Key Scheduling** — `Intl.DateTimeFormat` to build a `DAY_HH:MM` key, then a single `array-contains` query.
- **Scoped Interface Declaration** — Declare request/response shapes inside the function body, not in a global types file.
- **Lazy Singletons / Pragmatic Safety** — `process.env.X!` for known env vars, top-level `initializeApp()` once.
