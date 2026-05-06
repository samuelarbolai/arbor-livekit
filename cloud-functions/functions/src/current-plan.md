# Current Plan: Arbor Livekit Cloud Functions

## Plan Summary
**Current Status (2026-05-01): Production loop is implemented; iterating on response shape for the v0 frontend.**

The cloud-functions module exposes four functions that together drive the ritual product loop: `helloWorld` (sanity), `registerNewRitual` (HTTP upsert from a Google Doc), `checkUsersRituals` (cron, every 30 min in `America/Bogota`), and `makeCallsBatchFunction` (HTTP, dispatches LiveKit agents). The current iteration adds the `userInputs` field to the registration endpoint's success response so the v0/Vercel frontend can display what Gemini extracted from the user's Google Doc.

## Plan Architecture (Flow)
1. Frontend POSTs `{ googleDocLink, geminiPrompt }` to `registerNewRitual`.
2. Function extracts `googleDocId` from the URL, fetches the doc body via the public `export?format=txt` endpoint.
3. Function calls Gemini (`gemini-2.5-flash`, JSON response) with the doc body + the user's prompt to produce a `RitualData` JSON.
4. Function looks up an existing ritual by `googleDocId`:
   - **Hit** → UPDATE that ritual; preserve its existing `userID`.
   - **Miss** → CREATE: canonicalize `userID`/`phoneNumber` against the `rituals` collection (lookup by `userID` then by `agentConfig.phoneNumber`), then insert a new document with an auto-ID.
5. Respond with `{ message, documentId, userID, userInputs }` so the frontend can render what Gemini produced.
6. Cron `checkUsersRituals` polls every 30 min (per timezone), builds a `DAY_HH:MM` key, and POSTs matching userIDs to `makeCallsBatchFunction`.
7. `makeCallsBatchFunction` loads each ritual and creates a LiveKit `AgentDispatch` per user. Failures inside individual calls are caught so they do not abort the batch.

## Plan Structure (Directories and files)
- **Primary file:** `samwise-backend/cloud-functions/functions/src/index.ts` — All four cloud functions live here.
- **Supporting files:**
  - `package.json` — Dependencies (`firebase-admin`, `firebase-functions`, `@google/generative-ai`, `livekit-server-sdk`, `cors`, `dotenv`).
  - `tsconfig.json` — TypeScript compiler config.
  - `.env` — Local env vars: `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
  - `programming-style.md` — Style guide (defensive batching, O(1) scheduling key, scoped interfaces, lazy singletons).
  - `context-for-code-agent.md` — Module context.

## Modifications (in phases and steps)

### Phase 1: Initial `registerNewRitual` (create-only) — ✅ DONE
**Location:** `index.ts`
**Implementation:**
- `onRequest` handler wrapped in `cors({ origin: true })`.
- Parses `{ googleDocLink, geminiPrompt }` from the request body.
- Extracts `documentId` from the URL via `/\/d\/([a-zA-Z0-9-_]+)/`.
- Fetches doc body via `https://docs.google.com/document/d/<id>/export?format=txt` (no auth; doc must be link-shareable).
- Calls Gemini with the doc body + user prompt; expects JSON matching the `RitualData` shape.
- Persists the result to `db.collection("rituals")` with an auto-generated doc ID.
- Canonicalizes identity: lookup by `userID` then by `agentConfig.phoneNumber` to attach the new ritual to an existing user if one matches; otherwise keep Gemini's values.

### Phase 2: Switch from create-only to upsert via `googleDocId` — ✅ DONE
**Location:** `index.ts` — `registerNewRitual`
**Implementation:**
- Added `googleDocId` to the `RitualData` interface; the URL ID is the dedup key (invariant to `?tab=`, `#heading=`, `?usp=sharing`, etc.).
- Kept `googleDocsLink` as a display-only field (the URL as received).
- Added a `googleDocId` lookup before the create branch:
  - **Hit** → `existingDoc.ref.set(ritualData, { merge: true })`, preserving the stored `userID`.
  - **Miss** → fall through to the existing create branch (with identity canonicalization).
- Identity canonicalization remains create-only: a user may own many rituals (one per Google Doc), so we only dedup the ritual itself, not the user.

### Phase 3: Return `userInputs` in the response — ✅ DONE (2026-05-01)
**Location:** `index.ts` — `registerNewRitual`
**Goal:** Surface `agentConfig.userInputs` in the success response so the v0/Vercel frontend can render what Gemini extracted, without an extra Firestore round-trip from the client.

**In-file changes:**
- UPDATE branch (`res.status(200).send(...)` after the merge write): add `userInputs: ritualData.agentConfig.userInputs` as a top-level response field.
- CREATE branch (`res.status(200).send(...)` after the new-doc write): add `userInputs: ritualData.agentConfig.userInputs` as a top-level response field.

**Specification of what NOT to modify:**
- Other cloud functions (`helloWorld`, `checkUsersRituals`, `makeCallsBatchFunction`) and their internals.
- The `RitualData` / `AgentConfig` interfaces and the Firestore document shape.
- The Gemini prompt and the dedup-by-`googleDocId` logic.
- The identity canonicalization logic (userID/phoneNumber lookup).

**Response shape (both branches):**
```json
{
  "message": "...",
  "documentId": "<firestore doc id>",
  "userID": "<canonical user id>",
  "userInputs": "<string from agentConfig.userInputs>"
}
```

**Why top-level (not nested under `agentConfig`):**
- The frontend only needs to render `userInputs`; flattening it avoids exposing the rest of the agent config in the response payload and keeps the v0 component simple.

### Phase 3.5: Consistent JSON error envelope on `registerNewRitual` — ✅ DONE (2026-05-01)
**Goal:** Make every response from `registerNewRitual` a JSON object so the v0 frontend can use the same `res.json()` parse on success and failure paths.

**In-file changes:**
- All five error paths in `registerNewRitual` now send `{ error: "<message>" }` instead of a plain string. Status codes (400/500) unchanged. Sites: missing `googleDocLink`, invalid Google Doc link, doc fetch failure, Gemini parse failure, top-level catch.

**Specification of what NOT to modify:**
- Success response shape (already JSON).
- HTTP status codes — already correct.
- Error responses in `makeCallsBatchFunction` (it is called by the cron, not by the browser, so the plain-string body is fine and out of scope).
- Any other function.

**Frontend contract:**
- On success (2xx): `{ message, documentId, userID, userInputs }`.
- On error (4xx/5xx): `{ error: "<human-readable message>" }`.

### Phase 3.6: Hardcoded synthesis prompt + metadata-tab data model — ✅ DONE (2026-05-01)
**Goal:** Eliminate the per-request `geminiPrompt` and switch to a deterministic data model where the Google Doc itself is the single source of truth, with structured fields living in a dedicated Metadata tab. The Gemini call becomes a pure synthesis step driven by a hardcoded prompt.

**Architectural shift:**
- Each ritual Google Doc now has three tabs: `Problem - Solution`, `Coach Call`, `Metadata` (see `google-doc-template.md` for the canonical structure).
- Request body shrinks to `{ googleDocLink }` only.
- `agentConfig.phoneNumber`, `agentConfig.voiceID`, `agentConfig.language`, `timeZone`, `userID` come from the Metadata tab (parsed in-process by regex; no LLM in the metadata path).
- `agentConfig.userInputs`, `schedules`, `fallbackSchedules` come from a single Gemini call driven by a hardcoded synthesis prompt. `userInputs` carries the filled `<user-inputs>` XML plus the `UNMAPPED MATERIAL` section concatenated as one string (per Rule 6).
- `fallbackActive` is hardcoded `false`; flip later via direct Firestore edit if ever needed.
- `googleDocId`/`googleDocsLink` still derived from the URL as before.

**In-file changes (`index.ts`):**
- Removed `geminiPrompt` from `RegisterRequest` and the body destructure.
- Added module-level `SYNTHESIS_PROMPT` constant containing the caller-provided synthesis prompt. Body (Rules 1-8, Rule 7 tag-by-tag semantics, worked example) is verbatim from the caller; only Rule 9 was rewritten to a JSON envelope (to fit `responseMimeType: "application/json"`), and a new Rule 10 was appended for deterministic `DAY_HH:MM` schedule extraction.
- Added in-handler metadata parser: regex per required key (`userID`, `voiceID`, `language`, `phoneNumber`, `timeZone`); missing keys → 400 with the missing names.
- Added language-statement injection: appends `[NOTE: The user has separately specified they want the call conducted entirely in <language>.]` to the raw material before sending to Gemini, matching the worked example's pattern so Rule 1 has an explicit signal.
- `fullPrompt` built via `SYNTHESIS_PROMPT.replace("[INSERT RAW USER INPUT HERE]", () => enrichedDocContent)`. Function-form replacement avoids `$` interpretation in raw doc content.
- Gemini result parsed into a scoped `SynthesisResult` interface (`{ userInputs, schedules, fallbackSchedules }`). `RitualData` is then built from metadata + synthesis output.
- Existing upsert-by-`googleDocId` and identity canonicalization logic untouched. Canonicalization is now mostly a no-op in the happy path (since metadata `userID` is canonical), but kept as a safety net.

**Worked example output format:**
The worked example in the synthesis prompt still shows the XML synthesis (it teaches Rules 1-8). A `NOTE ON FORMAT` paragraph was added explaining that the example output illustrates the value of the `userInputs` string, and the final Gemini output must be the JSON envelope from Rule 9 (with schedules/fallbackSchedules per Rule 10). One concrete schedule example for the worked-example raw material was added (`["SUN_13:00", ...]`) so Gemini sees a complete input → JSON-output transformation.

**Specification of what NOT to modify:**
- The synthesis prompt body (Rules 1-8, the worked example raw input/output, the tag semantics).
- The Firestore `RitualData` schema.
- Other cloud functions.
- Upsert-by-`googleDocId` logic.

### Phase 3.7: SKILL.md compliance pass — ✅ DONE (2026-05-01)
**Goal:** Bring the synthesis prompt and surrounding code into compliance with the `ritual-synthesis-prompt` skill (`arbor/.claude/skills/ritual-synthesis-prompt/SKILL.md`).

**Changes made:**
- **Worked example rewritten as JSON envelope.** The example output in the prompt now uses the JSON shape from Rule 9 (`{ userInputs, schedules, fallbackSchedules }`) with the XML and `UNMAPPED MATERIAL` section properly JSON-escaped inside the `userInputs` string. The schedules array shows the 7 daily slots derived from "Daily at 1pm" so the example exercises Rule 10. Per the skill: "weaker models follow demonstrated behavior more reliably than described behavior."
- **Final recency-bias reminder added** before `RAW MATERIAL TO PROCESS:` re-emphasizing Rule 2 (don't replace detachment metaphors with clinical terms). Recency bias makes the last instruction stick best.
- **Prompt extracted to a sibling file.** `ritual_synthesis_prompt.txt` lives next to `index.ts`. The cloud function now loads it via `fs.readFileSync(path.join(__dirname, "ritual_synthesis_prompt.txt"), "utf-8")` at module load. The `build` script copies the .txt into `lib/` so `__dirname` resolution works at runtime in both the emulator and production.
- **Skill installed** at `arbor/.claude/skills/ritual-synthesis-prompt/SKILL.md` with the audit step for Rule 9 reworded for the JSON envelope, Rule 10 added to the quick-reference list and the swap-the-example checklist, and the file-orbit list updated to point at the actual repo paths.

**Skill-managed concerns intentionally NOT changed:**
- Language injection still uses the raw value from the Metadata tab (per user direction: therapists put the language name directly in metadata; no code-side mapping).
- Final recency-bias reminder is a single sentence on Rule 2; expand only if Rule 2 violations recur in production.

### Phase 4: v0 Frontend Update — ✅ PROMPT DELIVERED (2026-05-01)
**Goal:** Update the existing v0 component that calls `registerNewRitual` so it reads `userInputs` from the response and renders it as a new visual block.
**Note:** The actual frontend lives in v0/Vercel; this repo only ships the prompt to feed v0. Placement and styling are intentionally left to v0.

**Prompt handed to the user (paste into v0):**
> The success response of the `registerNewRitual` endpoint now includes a new top-level string field: `userInputs`.
>
> Modify the existing component that calls this endpoint to render `userInputs` as a new visual block after a successful response. It can be a long multi-line string, so render it in a way that preserves whitespace and newlines.

### Phase 6: Promote `users/{userID}` to a canonical user doc + add ritual `label` — 📋 PLANNED (2026-05-05)
**Goal:** Make `cloud-functions/registerNewRitual` the single writer for a top-level `users/{userID}` doc that mirrors the user-level fields currently buried inside `rituals.agentConfig` (phone, language, voice, timezone) and that holds a map of all the user's rituals keyed by `googleDocId`, with a human-readable `label` per ritual sourced from the Google Doc title. The `tracking-workflow` module then consumes this doc as its single source of truth for dispatch metadata, including the per-ritual list passed to the `tracking-agent` so it can ask KPIs per ritual.

**Why:** `phoneNumber`, `language`, `voiceID`, `timeZone` are user-level facts that happen to be stored per-ritual today. With multiple rituals per user that's both redundant (same value copied N times) and ambiguous (which ritual do downstream consumers read from?). Promoting them to a `users/{userID}` doc removes the redundancy, eliminates the "smallest googleDocId tiebreaker" that `tracking-workflow` was forced into, and gives the tracking-agent a clean per-ritual list to walk through. The `label` field is sourced from the Google Doc title (therapists already name docs meaningfully), avoiding any new prompt work.

**In-file changes (`index.ts` — `registerNewRitual` only):**

1. **Fetch the Google Doc title** at registration time, in the same step that already fetches the body. Use the Google Drive API (the existing Firebase service account in `GOOGLE_APPLICATION_CREDENTIALS` has access — same project, no new auth):
   ```ts
   import { google } from "googleapis";
   // ... inside registerNewRitual, alongside the existing doc-body fetch ...
   const drive = google.drive({ version: "v3" });
   const meta = await drive.files.get({ fileId: googleDocId, fields: "name" });
   const ritualLabel = meta.data.name ?? "Untitled ritual";
   ```
   Add `googleapis` to `package.json` dependencies if not already present. Drive API quota is generous; one call per registration is well within limits.

2. **Store `label` on the rituals doc.** In the `RitualData` write (both CREATE and UPDATE branches), add a top-level `label: ritualLabel` field. The display label lives next to `googleDocsLink` and the schedules — same precedence as other top-level ritual fields.

3. **After the existing `rituals` write succeeds** (both UPDATE and CREATE branches), append a `users/{canonicalUserID}` upsert:
   ```ts
   await db.collection("users").doc(canonicalUserID).set(
     {
       userID: canonicalUserID,
       phoneNumber: ritualData.agentConfig.phoneNumber,
       language: ritualData.agentConfig.language,
       voiceID: ritualData.agentConfig.voiceID,
       timeZone: ritualData.timeZone,
       ritualLabels: { [ritualData.googleDocId]: ritualLabel },
       updatedAt: FieldValue.serverTimestamp(),
     },
     { merge: true }
   );
   ```

4. **Idempotency.** `merge: true` plus a *map* (not an array) for `ritualLabels` means re-registering the same doc overwrites the entry for that `googleDocId` in place — no duplicates, and a renamed Google Doc updates its label automatically. Adding a *new* doc for the same user merges in a new key without touching the others. (Maps are the right shape here precisely because `arrayUnion` does deep-equality on whole elements; if the label changes for an existing ID, an array-of-objects approach would silently add a duplicate entry.)

5. **Last-write-wins** on the user-level scalar fields (`phoneNumber`, `language`, `voiceID`, `timeZone`). If a user updates their phone number on a newer ritual, that becomes the canonical phone. Acceptable for v1 — phone changes are rare and the latest registration is the safest signal.

**`users` doc shape (canonical reference):**
- `userID: string` — canonical, matches the doc ID.
- `phoneNumber: string`
- `language: string` — raw language name as written in the Metadata tab (e.g. `"English"`, `"Español"`). No code-side mapping.
- `voiceID: string`
- `timeZone: string` — IANA tz.
- `ritualLabels: { [googleDocId: string]: string }` — map of all the user's rituals to their human-readable labels. The list of `googleDocId`s is `Object.keys(ritualLabels)`.
- `updatedAt: Timestamp` — server-stamped on every registration write.
- (Other modules may merge-write additional fields — e.g. `tracking-workflow` writes `lastTrackingEventAt` and `trackingEvents` is its own collection. This module is the writer for the fields above; other writers must use disjoint field names.)

**`rituals` doc shape addition:**
- `label: string` — Google Doc title at registration time. Refreshes on every re-registration.

**Specification of what NOT to modify:**
- The rest of the `rituals` collection schema. `agentConfig.phoneNumber` etc. stay where they are; this phase mirrors them into `users`, it doesn't move them.
- Identity canonicalization logic (lookup by userID then phoneNumber). The canonicalized userID is the doc ID for `users`.
- Any other cloud function. `checkUsersRituals` and `makeCallsBatchFunction` continue to read from `rituals` — they don't need the new doc.
- The Gemini synthesis prompt or the metadata-tab parser.

**Testing phase:**
- **Local:** emulator. Register a new ritual; assert (a) the `rituals` doc has a top-level `label` matching the Google Doc title, (b) `users/{userID}` is created with all six fields and `ritualLabels[googleDocId] === label`. Register a second ritual for the same user with a different doc title; assert `ritualLabels` now has two keys and the other fields reflect the latest values. Re-register the first doc after renaming it in Drive; assert `ritualLabels[firstId]` reflects the new title.
- **Integration:** redeploy; have the v0 frontend register a fresh test user. Confirm via Firestore console.

**Deliverable:** Every successful registration writes a `rituals` doc with `label` and a `users` doc with the five user-level fields plus `ritualLabels`. The `tracking-workflow` module can read `users/{userID}` directly to build dispatch metadata, including the per-ritual labels needed for the multi-ritual conversation flow in `tracking-agent`.

### Phase 5: Tracking Loop integration endpoints — ❌ CANCELLED (2026-05-04)
**Outcome:** Reverted before any code was written. Originally drafted to add `dispatchTrackingCall` and `trackingCallback` as two new HTTP endpoints in this module. On review with the user, the split was wrong: neither endpoint had a real reason to live in Firebase rather than alongside the orchestration on Vercel, and putting them here added two unnecessary HTTP hops (workflow → Firebase → LiveKit, agent → Firebase → workflow). Both responsibilities now live in `samwise-backend/tracking-workflow/`:

- The dispatch is an inline `context.run()` step inside the per-user workflow (uses `AgentDispatchClient` with the same LiveKit credentials this module already exports).
- The callback is a Vercel route at `/api/tracking-callback` that the LiveKit tracking-agent posts to directly.

This module is unchanged for the tracking feature. No env vars, no new endpoints, no new collections owned here. See `samwise-backend/tracking-workflow/current-plan.md` for the actual implementation plan.

## Update Status
### Completed ✅
- `helloWorld`, `registerNewRitual`, `checkUsersRituals`, `makeCallsBatchFunction` implemented.
- Upsert-by-`googleDocId` for `registerNewRitual`.
- `userInputs` returned in both UPDATE and CREATE response branches.
- All `registerNewRitual` error responses now use `{ error: "<message>" }` JSON shape.
- Hardcoded synthesis prompt (Rule 9 → JSON, new Rule 10 for `DAY_HH:MM` schedules); request body shrunk to `{ googleDocLink }` only.
- Metadata tab parsed in-process for `userID` / `voiceID` / `language` / `phoneNumber` / `timeZone`.
- Three-tab Google Doc template (`google-doc-template.md`) committed to the repo.
- Synthesis prompt extracted to `ritual_synthesis_prompt.txt` and loaded at runtime; build script copies it into `lib/`. Worked example rewritten as JSON envelope. Final recency-bias reminder added.
- `ritual-synthesis-prompt` skill installed at `arbor/.claude/skills/ritual-synthesis-prompt/SKILL.md`.
- `context-for-code-agent.md` and `current-plan.md` brought up to date.

### Pending 📋
- v0 frontend modification (prompt delivered; user applies in v0 and verifies render).
- Phase 6: `users/{userID}` upsert in `registerNewRitual` (planned 2026-05-05; consumed by `tracking-workflow` as source of truth for dispatch metadata).

## Important Notes
- **Style:** Follow `programming-style.md` — declare request/response interfaces inside the function body, use `process.env.X!` for known env vars, use `array-contains` on `DAY_HH:MM` keys instead of range queries, and wrap individual batch calls in `.catch` rather than letting one failure abort `Promise.all`.
- **Firebase project:** Same project for everything; no extra service-account auth at runtime — `GOOGLE_APPLICATION_CREDENTIALS` is preset.
- **Doc fetching:** Uses the public `export?format=txt` URL; the Google Doc must be link-shareable.
