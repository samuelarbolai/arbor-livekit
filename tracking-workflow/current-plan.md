# Current Plan: `tracking-workflow` Module

## Plan Summary
**Status (2026-05-04): not yet scaffolded.** This is a brand-new Vercel-hosted Next.js (API-only) project that orchestrates the daily tracking loop. It is the most complex of the three modules in this feature, so the phases below are deliberately small and end-to-end-testable in isolation. The plan ships v1 (outbound only — voice call → SMS chat fallback → link delivery) in seven phases. Proactive-inbound SMS is explicitly deferred to a future v2 phase recorded at the bottom of this file.

## Plan Architecture (Flow)
1. QStash schedule per timezone fires at 18:00 and 20:00 local → POSTs `{ tz, round }` to `/api/tracking-workflow/root`.
2. Root workflow loads `rituals.where("timeZone", "==", tz)`, dedups by `userID`, fans out via `context.invoke` to per-user runs.
3. Per-user run does idempotency check → dispatches voice call → waits for callback (`tracking-call-result-${runId}`) → if voice incomplete, switches to SMS chat (`sms-reply-${runId}`) → finalizes Firestore + sends link.
4. Mastra SMS agent runs one step per inbound message, driven by `/api/sms-inbound` calling `client.notify`.

## Plan Structure (Directories and files)
See "Module Structure" in `context-for-code-agent.md`. All files are anticipated; nothing exists on disk yet besides this plan and the context file at the module root.

## Modifications (in phases and steps)

### Phase 1: Scaffold a Next.js (API-only) project on Vercel — ✅ DONE (locally; pending first Vercel deploy)
**In-directory location:** `samwise-backend/tracking-workflow/`
**Specification of what should NOT be modified:**
- Sibling modules.
- Anything in `cloud-functions/` — this phase doesn't need it yet.

**Steps:**
1. From the module root: `pnpm create next-app@latest . --ts --eslint --app --no-tailwind --src-dir false --import-alias '@/*'`. Skip the Tailwind / pages-router / Turbopack prompts to keep the project minimal.
2. Delete `app/page.tsx`, `app/layout.tsx`, `public/`, and any default UI assets — this is API-only.
3. Add deps: `pnpm add @upstash/workflow @upstash/qstash firebase-admin livekit-server-sdk telnyx zod`. Add `pnpm add -D tsx`.
4. Create `lib/firestore.ts` with the lazy-singleton init pattern (`let initialized = false; if (initialized) return; initializeApp({credential: cert(JSON.parse(Buffer.from(env, 'base64').toString()))}); initialized = true`).
5. Create `lib/livekit.ts` exporting a lazy-singleton `AgentDispatchClient` initialized from `LIVEKIT_URL/API_KEY/API_SECRET`.
6. Create a stub `app/api/tracking-workflow/root/route.ts` that just logs the body and returns 200; deploy to Vercel via `vercel --prod` once to confirm deploy hooks work end-to-end.
7. Set Vercel env vars: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON` (base64), `LIVEKIT_URL/API_KEY/API_SECRET` (same project as `tracking-agent`), `TRACKING_CALLBACK_URL` (set after first deploy to `<deploy-url>/api/tracking-callback`).
8. Move the working files (this file and `context-for-code-agent.md`) from the module root into the project — keep them at the module root, not under `app/` (they describe the module, not the routes).

**Deliverable:** A Vercel deploy URL that returns 200 on `POST /api/tracking-workflow/root` with any body.

### Phase 2: Per-user workflow skeleton with idempotency check — ✅ DONE (2026-05-05)
**In-file location:** `app/api/tracking-workflow/per-user/route.ts`
**Specification of what should NOT be modified:**
- The schema of `trackingEvents` documents — it's the canonical contract documented in this module's `context-for-code-agent.md`. This module is the sole writer.

**Code-ready skeleton:**
```ts
import { serve } from "@upstash/workflow/nextjs";
import { db } from "@/lib/firestore";

interface PerUserPayload {
  userID: string;
  runId: string;
  tz: string;
  round: 'primary' | 'retry';
}

export const { POST } = serve<PerUserPayload>(async (context) => {
  const { userID, runId, tz, round } = context.requestPayload;

  // 1. Idempotency: if today's KPIs are already complete, exit.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()); // YYYY-MM-DD
  const eventDocId = `${userID}_${date}`;

  const alreadyComplete = await context.run('idempotency-check', async () => {
    const snap = await db.collection('trackingEvents').doc(eventDocId).get();
    if (!snap.exists) return false;
    return allRitualsComplete(snap.data() as TrackingEvent);
  });
  if (alreadyComplete) return;

  // ... Phase 3 inserts the dispatch + waitForEvent here.
});
```

**Why `en-CA` locale for the date format:** `en-CA` produces ISO-style `YYYY-MM-DD` directly; the `pt-PT` workaround used elsewhere is harder to read. Behavior is documented to be stable in Node's Intl.

**Deliverable:** Trigger the workflow manually with a user that already has a complete event for today; assert via Vercel logs that the run exits without dispatching.

### Phase 3: Voice dispatch + tracking-callback route + waitForEvent — ✅ DONE (2026-05-05; pending integration test against deployed agent)
**In-file locations:** `app/api/tracking-workflow/per-user/route.ts`, `app/api/tracking-callback/route.ts`, `lib/livekit.ts`, `lib/tracking-events.ts`.
**Specification of what should NOT be modified:**
- The deployed `tracking-agent` — its instructions and tool surface are anchored by its own Phase 4 tests. The dispatch metadata contract (`user_id`, `run_id`, `tracking_callback_url`, `language`, `voice_id`, `phone_number`, `room_name`) is fixed; if you change it, also update `tracking-agent/src/main.ts` and re-deploy.
- The `trackingEvents` doc shape (canonical reference: this module's `context-for-code-agent.md`).

**Step 1 — `lib/tracking-events.ts`:**
- Export `mergeFinal(eventDocId, partial)` that reads the doc, applies the monotonic-merge invariant **per `(googleDocId, kpiField)`** (only flip `null` → `boolean`, never overwrite an existing boolean; `ritualUsedOut` is a one-way OR per ritual), appends an entry to `attempts`, and sets `completedAt` if every ritual's three KPIs are now non-null. This is the single writer used by both the voice path (callback route) and the SMS path (Phase 5 finalization). Idempotent on retries. See the worked example in `context-for-code-agent.md` for the multi-ritual case.
- Also export `allRitualsComplete(doc)` so Phase 2's idempotency check and Phase 3's "skip SMS if voice fully covered" branch can both call it.

**Step 2 — `app/api/tracking-callback/route.ts`:**
- Plain Next.js route handler (not a workflow `serve()` — this is a one-shot HTTP endpoint).
- Body shape: `{ userID, runId, channel: "voice", conversationHappened, ritualKpis: { [googleDocId]: { relapse, ritualFulfilled, answeredCall, ritualUsedOut } } }`.
- Compute `eventDocId` (`${userID}_${date}` in the user's tz — re-read tz from `users/{userID}` since the agent doesn't echo it back).
- Call `mergeFinal(eventDocId, body)` to persist. The merge initializes any missing ritual entries from the incoming `ritualKpis` keys, so the first voice POST seeds the doc shape.
- Call `client.notify({ eventId: \`tracking-call-result-${body.runId}\`, eventData: <merged doc> })` to wake the parked workflow.
- Return 204. Idempotent on duplicate POSTs (the merge is monotonic; `client.notify` on an already-resumed workflow is a no-op per the skill's pitfalls).

**Step 3 — Per-user route, dispatch step:**
- Add a `context.run('dispatch-tracking-call', ...)` step that:
  - Reads `users/{userID}` for `phoneNumber`, `language`, `voiceID`, `timeZone`, and the `ritualLabels: { [googleDocId]: string }` map. Source of truth — owned by `cloud-functions/registerNewRitual` (Phase 6 there). If the doc is missing, hard-error and skip the run; do not silently fabricate it.
  - Builds dispatch metadata:
    ```ts
    {
      user_id,
      phone_number,
      language,
      voice_id,
      room_name: \`tracking-\${context.workflowRunId}\`,
      run_id: context.workflowRunId,
      tracking_callback_url: process.env.TRACKING_CALLBACK_URL,
      rituals: Object.entries(ritualLabels).map(([googleDocId, label]) => ({ googleDocId, label })),
    }
    ```
  - Calls `livekitClient.createDispatch(roomName, "tracking-agent", { metadata: JSON.stringify(metadata) })`.
- Use `context.workflowRunId` as the canonical correlation ID — do not invent a separate one.

**Step 4 — Per-user route, wait for callback:**
- `await context.waitForEvent('voice-result', \`tracking-call-result-${context.workflowRunId}\`, { timeout: '5m' })`. The 5m timeout covers a typical SIP call worst case (ring timeout + voicemail prompt + agent shutdown callback latency). Multi-ritual conversations can be longer than single-ritual ones, but the 5m cap is on the *agent shutdown callback*, not the call duration — the agent posts as soon as it exits, regardless of how many rituals it walked through.
- The event payload, on resolve, contains the merged `trackingEvents` doc as written by the callback route. Inspect it:
   - If `allRitualsComplete(doc)` (every ritual's three KPIs collected via voice) → jump to the link-delivery step in Phase 5.
   - Else → fall through to SMS path (Phase 4). The SMS chat picks up only the `(ritual, KPI)` pairs still null; the monotonic merge guarantees already-collected ones stay.

**Deliverable:** A successful voice call with all three KPIs answered ends the workflow without entering the SMS path. The `trackingEvents` doc has all three KPIs and `completedAt` set.

### Phase 4: SMS chat fallback (Mastra + Telnyx + index doc) — 📋 PLANNED
**In-file locations:** `app/api/tracking-workflow/per-user/route.ts`, `app/api/sms-inbound/route.ts`, `lib/chat-agent.ts`, `lib/telnyx.ts`.
**Specification of what should NOT be modified:**
- The voice path (Phase 3) — SMS is purely additive.
- The shape of the `trackingEvents` doc.

**Steps:**
1. **`lib/telnyx.ts`** — `sendSms(to: string, body: string)` and `verifyInboundSignature(req)` (Ed25519 against `TELNYX_PUBLIC_KEY`).
2. **`lib/chat-agent.ts`** — Mastra agent with per-ritual KPI tools (`recordKPI({ googleDocId, field, value })`, `markRitualUsedOut({ googleDocId })`, `complete()`) — see `context-for-code-agent.md`'s "Mastra SMS Chat Agent" section for full signatures. Background prompt mirrors the voice agent's per-ritual walkthrough: agent gets a `rituals: [{ googleDocId, label }]` list at invocation, walks through each in turn asking the three KPIs, calls `complete()` once every ritual is recorded or marked used-out. Same SMS-shortened, language-aware tone. ONE `maxSteps: 1` per invocation; the workflow runs the loop, not the agent.

   The `rituals` list passed in is the *remaining* rituals — i.e. those still missing one or more KPIs in the current `trackingEvents` doc. Already-complete rituals are filtered out before each invocation, so the agent never re-asks. The filter lives in the per-user route, not the chat agent.
3. **Per-user route — SMS branch:**
   ```ts
   await context.run('record-active-sms-run', async () => {
     await db.collection('smsActiveRuns').doc(metadata.phoneNumber).set({
       runId: context.workflowRunId,
       expiresAt: Date.now() + 90 * 60 * 1000,
     });
   });

   await context.run('send-sms-opener', () => sendSms(metadata.phoneNumber, openerForLanguage(metadata.language)));

   const TURN_BUDGET = 6;
   for (let i = 0; i < TURN_BUDGET; i++) {
     const reply = await context.waitForEvent('sms-turn', `sms-reply-${context.workflowRunId}`, { timeout: '30m' });
     if (reply.timeout || reply.eventData?.done) break;
     const next = await context.run(`agent-turn-${i}`, async () => runMastraTurn(reply.eventData));
     if (next.done) break;
     await context.run(`send-sms-${i}`, () => sendSms(metadata.phoneNumber, next.message));
   }

   await context.run('clear-active-sms-run', () => db.collection('smsActiveRuns').doc(metadata.phoneNumber).delete());
   ```
4. **`app/api/sms-inbound/route.ts`:**
   - Verify Telnyx signature; reject if invalid.
   - Look up `smsActiveRuns/{phoneNumber}`. If absent → log and return 200 (drop). v1 explicitly does not handle proactive-inbound.
   - Else → `client.notify({ eventId: \`sms-reply-${runId}\`, eventData: { from: phoneNumber, body: text } })`.
5. **Mastra `complete()` tool** writes the final KPIs into the `eventData` so the `done: true` branch in the workflow loop can immediately drop into Phase 5 link delivery.

**Open question to resolve before starting Phase 4:** The chat-agent prompts must be authored per language (es/en at minimum). Either ship a small `i18n.ts` lookup or pass language straight into the prompt template. Keeping it as a lookup is cleaner; do that.

**Deliverable:** A user who misses the voice call but replies to the SMS opener completes the three KPIs over SMS and the workflow finalizes correctly.

### Phase 5: Final write + link delivery — 📋 PLANNED
**In-file location:** `app/api/tracking-workflow/per-user/route.ts`, `lib/links.ts`, `lib/tracking-events.ts`.

Note: `lib/tracking-events.ts`'s `mergeFinal` was already created in Phase 3 for the voice callback. This phase reuses it for the SMS finalization path; same monotonic-merge contract, no new helper.

**Steps:**
1. **`lib/links.ts`** — `decideLink(ritualKpis: TrackingEvent['ritualKpis']): string | null`. Aggregates across all rituals in the doc with explicit precedence (used-out > failure > none), returning **exactly one** link:
   ```ts
   const NEW_BELIEF = 'https://cal.com/samuel-giraldo-concha-yqvtot/new-belief';
   const OPTIMISATION = 'https://cal.com/samuel-giraldo-concha-yqvtot/optimisation';

   export function decideLink(ritualKpis: TrackingEvent['ritualKpis']): string | null {
     const bundles = Object.values(ritualKpis);
     const anyUsedOut = bundles.some(b => b.ritualUsedOut === true);
     if (anyUsedOut) return NEW_BELIEF;
     const anyFailure = bundles.some(b => b.relapse === true || b.ritualFulfilled === false || b.answeredCall === false);
     return anyFailure ? OPTIMISATION : null;
   }
   ```
   Precedence rationale: used-out is the rarer + stronger signal — a user who's outgrown one ritual is offered the new-belief flow even if their other rituals also have failures (those will still be re-asked tomorrow; the used-out signal is the one that needs immediate follow-up). For single-ritual users this collapses exactly to the original v1 semantics.
2. **Per-user route — SMS finalization:**
   ```ts
   const final = await context.run('merge-final', () => mergeFinal(eventDocId, collected));
   const link = decideLink(final);
   if (link) await context.run('send-link', () => sendSms(metadata.phoneNumber, linkMessageForLanguage(metadata.language, link)));
   ```
   The voice path already wrote to Firestore from `/api/tracking-callback` in Phase 3; after the parked workflow wakes, it also calls `decideLink` + `sendSms`, so link delivery is symmetric across channels.
3. Update `users/{userID}` with `lastTrackingEventAt: serverTimestamp()`.

**Specification of what should NOT be modified:**
- The two cal.com URLs (per the original task description; quoted verbatim).
- The `mergeFinal` contract (must stay monotonic; both the callback route and the SMS finalization rely on it).

**Deliverable:** End-to-end run produces (a) a finalized `trackingEvents` doc with `completedAt` set, (b) the correct cal.com link sent (or none) based on the decision matrix, (c) `users/{userID}.lastTrackingEventAt` updated.

### Phase 6: Root workflow + per-timezone fan-out — ✅ DONE (2026-05-06; pending integration test)
**In-file locations:** `lib/workflows/root.ts`, `lib/workflows/per-user.ts`, `app/api/tracking-workflow/[...any]/route.ts`. The original `app/api/tracking-workflow/root/route.ts` and `.../per-user/route.ts` were deleted; both workflows are now defined via `createWorkflow` and co-mounted under one `serveMany` at the catch-all route. Public URLs are unchanged (`/api/tracking-workflow/root`, `/api/tracking-workflow/per-user`).

**Steps:**
1. Body shape: `{ tz: string, round: 'primary' | 'retry' }` (set by the QStash schedule).
2. Load `rituals.where("timeZone", "==", tz)`, then `Array.from(new Map(snap.docs.map(d => [d.data().userID, d.data()])).values())` to dedup by `userID`.
3. For each unique user, `context.invoke` a per-user run with `{ userID, runId: <generated>, tz, round }`. Use `context.invoke` rather than per-user `client.trigger` so the root run waits and Vercel logs show the full tree.
4. Apply `flowControl` on the invoke calls to cap concurrency; start with `parallelism: 5` to be gentle on Telnyx and LiveKit.

**Deliverable:** Trigger the root workflow with a synthetic `{ tz: "America/Bogota" }` and observe N child runs in the Upstash Workflow dashboard, where N = unique users in that timezone.

### Phase 7: QStash schedules + integration tests — ✅ DONE (script ready; pending one-shot run + integration test)
**In-file locations:** `scripts/sync-schedules.ts`, plus a brief `INTEGRATION.md` describing the manual end-to-end test runbook (NOT a documentation deliverable for the user — an internal runbook for ourselves so we can re-run the integration test reliably).

**Steps:**
1. **`scripts/sync-schedules.ts`** — runs the `client.schedules.create({...})` loop documented in the new `upstash-workflow-js/basics/scheduling.md` skill page. Idempotent via stable `scheduleId`. List of timezones lives in the script as a `const` array; updating is a one-line edit + script re-run.
2. **Integration runbook** — manual checklist:
   1. Set Vercel env vars; deploy.
   2. Run `pnpm tsx scripts/sync-schedules.ts` against the dev Upstash project.
   3. Prepare a test user with one ritual, a real phone, `timeZone: "America/Bogota"`.
   4. Manually `curl` the root route with that timezone (don't wait for the cron) → observe the child run dispatch.
   5. Answer the call; verify `trackingEvents` doc has all three KPIs and `completedAt`.
   6. Repeat with a no-answer scenario (don't pick up); verify SMS opener arrives, reply via SMS, verify chat completes.
   7. Repeat with the "I don't need this anymore" exception; verify the new-belief link arrives instead of optimisation.

**Specification of what should NOT be modified:**
- The deployed `tracking-agent` (LiveKit Cloud, agent ID `CA_k5weq8CbDWjR`) — already shipped; Phase 3's dispatch metadata contract anchors it.
- The QStash schedule pattern — use the skill's recommended `timezone` field, do not inline `TZ=`.

**Deliverable:** Three successful end-to-end runs (voice success, SMS fallback, used-out exception), each producing the correct Firestore state and SMS link.

## Update Status
### Completed ✅
- Module dir created at `samwise-backend/tracking-workflow/`.
- Working files (this file and `context-for-code-agent.md`) drafted.
- **Phase 1 (scaffold)** — Next.js 16 (App Router, API-only) up; deps installed (`@upstash/workflow`, `@upstash/qstash`, `firebase-admin`, `livekit-server-sdk`, `telnyx`, `zod`, `tsx`); `lib/firestore.ts` and `lib/livekit.ts` lazy-singletons in place; stub `app/api/tracking-workflow/root/route.ts` returns 200. Pending: first Vercel deploy + env vars.
- **Phase 2 (idempotency check)** — `app/api/tracking-workflow/per-user/route.ts` parses payload, computes per-tz date, exits early if `allRitualsComplete`. `lib/tracking-events.ts` ships the `TrackingEvent` type, `KpiBundle`, `allRitualsComplete`.
- **Phase 3 (voice dispatch + callback + waitForEvent)** — `lib/tracking-events.ts` gained `mergeFinal()` (per-`(googleDocId, kpiField)` monotonic merge in a Firestore transaction). `lib/workflow-client.ts` added (lazy `@upstash/workflow` `Client` for `client.notify`). `app/api/tracking-callback/route.ts` reads body, looks up tz from `users/{userID}`, calls `mergeFinal`, then `client.notify('tracking-call-result-${runId}')`. `per-user/route.ts` reads `users/{userID}`, builds dispatch metadata (including the `rituals` array from `ritualLabels`), calls `livekitDispatch().createDispatch(roomName, 'tracking-agent', { metadata })`, and `await context.waitForEvent('voice-result', ...)`. Branches on `allRitualsComplete(merged)` for done vs SMS-fallback. Build is clean (3 routes registered).
- **Phase 5 piece** — `lib/links.ts` ships `decideLink(ritualKpis)` with the precedence rule (used-out > failure > none). Wiring it into the per-user route is pending Phase 4 (SMS path).
- **Phase 6 (root + per-tz fan-out)** — `lib/workflows/root.ts` and `lib/workflows/per-user.ts` defined via `createWorkflow`; co-mounted at `app/api/tracking-workflow/[...any]/route.ts` via `serveMany({ root, 'per-user': perUser })`. Root loads `rituals.where('timeZone', '==', tz)`, dedups by `userID`, and fans out via `Promise.all` of `context.invoke(perUserWorkflow, ...)` calls under shared `flowControl: { key: 'tracking-per-user', parallelism: 5 }`. New trigger script `scripts/trigger-root.ts` takes `[tz] [round]` and posts to `/api/tracking-workflow/root`. Pending: deploy + integration test (trigger root for `America/Bogota`, observe N child runs in Upstash dashboard).
- **Phase 7 (QStash schedules + integration runbook)** — `scripts/sync-schedules.ts` ships with `TIMEZONES = ['America/Bogota']` and two ROUNDS (primary @ 18:00, retry @ 20:00). Idempotent via stable `scheduleId` (`tracking-{round}-{tz-slug}`). Timezone bound to the cron via `CRON_TZ=<tz>` prefix syntax — the `@upstash/qstash` SDK 2.10.1's `CreateScheduleRequest` doesn't expose a `timezone` field (the skill page is outdated for this version), but QStash's REST endpoint accepts the prefix. Flags: no flag = sync, `--list` = print existing tracking-* schedules, `--delete` = remove all tracking-* schedules. Running it: `pnpm tsx scripts/sync-schedules.ts`. Pending: one-shot run against the production Upstash project + the manual integration runbook below.

### Integration runbook 📋
Manual end-to-end test for the cron path (Phase 6+7), independent of Telnyx Messaging Profile:
1. Confirm Vercel env is fully populated (production scope): `QSTASH_*`, `LIVEKIT_*`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `TRACKING_CALLBACK_URL`. Use `vercel env pull --environment=production .env.local` if local also needs to match.
2. From `samwise-backend/tracking-workflow`: `pnpm tsx scripts/sync-schedules.ts`. Confirm 2 schedules created/updated. `--list` afterwards to verify.
3. Without waiting for the cron: `pnpm tsx scripts/trigger-root.ts America/Bogota primary`. This synthetically fires the root workflow.
4. Watch the Upstash Workflow dashboard for 1 root run + N child runs (N = unique users in `rituals` with `timeZone == America/Bogota`). Each child run should show `[per-user] invoke` → `idempotency-check` → `load-user` → `dispatch-tracking-call` → `waiting for voice-result`.
5. Answer the call; verify `trackingEvents/{userID}_{date}` doc has all KPIs and `completedAt` set. Verify `[per-user] voice fully covered all rituals — done` log line.
6. (BLOCKED until Phase 4 ships) No-pickup scenario → SMS opener arrives, reply via SMS, chat completes.
7. (BLOCKED until Phase 5 wires it in) Used-out exception → new-belief link arrives instead of optimisation.

### Pending 📋
- **Phase 4 (SMS chat fallback)** — Decisions resolved 2026-05-05: Mastra + `google/gemini-3-flash-preview` (same `GOOGLE_API_KEY` as narya/tracking-agent); es/en only; tsconfig will bump to ES2022 when Mastra lands. Still BLOCKED on Telnyx Messaging Profile setup (user action).
- **Phase 5 (final write + link delivery)** — `decideLink` ready in `lib/links.ts`. Voice-success branch can be wired now (when `allRitualsComplete(merged)` after voice → call `decideLink` → Telnyx send). SMS-success wiring waits on Phase 4.

### Small follow-ups (from first end-to-end voice test 2026-05-05) 🔧
- **Bug fixed in `lib/tracking-events.ts` `allRitualsComplete`**: a ritual now counts as complete if `ritualUsedOut === true`, not only if all three KPIs are non-null. Without this, single-ritual conversations that ended via `markRitualUsedOut` left `completedAt` unstamped and would have leaked into the SMS path once Phase 4 lands.
- **6 audit-log entries with all-null partials** were observed in the test doc (`pZX1S3FySfgre88oHxHu09JqMGz1_2026-05-05.attempts`). Each represents a workflow run that timed out before the agent placed the call — expected during testing, but in production we may want `mergeFinal` to elide all-null partial pushes from `attempts` (to keep the audit log signal-dense). Leave as-is for now; revisit only if production audit logs get noisy.
- **No-op POST when callbackUrl missing**: `tracking-agent/src/main.ts` short-circuits the shutdown POST if `metadata.tracking_callback_url` is falsy. That's correct, but means a misconfigured dispatch fails silently. Consider logging an explicit warning at agent startup if the URL is missing — easier to spot than a workflow timeout 5 minutes later.

## Future Phase: v2 Proactive Inbound SMS — 🕐 DEFERRED
Out of scope for v1, intentionally. Adding it later requires:
- A second inbound path in `/api/sms-inbound` for messages from phones NOT in `smsActiveRuns`.
- A persistent Mastra memory keyed by user phone number (separate from per-run state) so the agent has context across the day.
- A second Firestore writer that bypasses `client.notify` (since there's no parked workflow to wake).
- Idempotency rules across two writers competing on the same daily `trackingEvents` doc — same monotonic-merge contract still applies, so this is mostly mechanical.

Do not start v2 until v1 has been running long enough to confirm users actually want to text first. Earliest revisit: after 2 weeks of v1 in production.

## Important Notes
- **`context.workflowRunId` is the canonical correlation ID.** Don't invent your own. The dispatch metadata embeds it as `run_id`; the agent echoes it back in the callback POST; the workflow waits on `tracking-call-result-${runId}`.
- **Monotonic KPI merges across two write paths in this module.** The voice callback route (`/api/tracking-callback`) and the SMS finalization step both flow through `mergeFinal` in `lib/tracking-events.ts`. The contract: only flip a KPI from `null` → `boolean`, never overwrite an existing boolean. Single writer (the helper), two callers — keeps the invariant local to one file.
- **Voice and SMS are completely separate runtimes.** Per the user's explicit statement. The workflow chooses which fires; they don't share connection or transport.
- **No proactive-inbound in v1.** SMS from a phone without an active run is dropped (logged, but no action). This is a deliberate scope cut; revisit only after v1 ships.
- **Single Telnyx account, two uses.** SIP voice (used by `tracking-agent` directly via the existing trunk) and Programmable Messaging (new, this module). Same `TELNYX_*` credentials base, different API surfaces. Confirm with Telnyx that messaging billing is enabled before Phase 4.
- **Schedule list lives in code, not a config file.** A `const TIMEZONES = [...]` in `scripts/sync-schedules.ts`. Adding a timezone is a one-line edit + a re-deploy + a script re-run. Don't over-engineer this.
- **`cloud-functions/` is unrelated to this module.** Don't import from it; don't call into it. They share Firestore but no HTTP relationship.
