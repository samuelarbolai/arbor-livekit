# Code Agent Context for the `tracking-workflow` Module

## Parent Project Overview
This module is the orchestration spine for the tracking feature AND owns the dispatch + callback responsibilities for voice tracking calls. It lives on **Vercel** (NOT Firebase) and carries four responsibilities:
1. **Scheduling** — QStash Schedules, one per IANA timezone, fire daily at 18:00 and 20:00 local and trigger this module's HTTP endpoint.
2. **Per-user state machine** — An Upstash Workflow that, for each active user in the timezone, decides whether to dispatch a voice tracking call (inline via `AgentDispatchClient`), waits for the agent's callback, and falls back to an SMS chat (via Mastra over Telnyx Programmable Messaging) if the voice path doesn't yield the three KPIs.
3. **Tracking-call dispatch + callback** — Both the LiveKit `AgentDispatch` creation and the agent's shutdown-callback receiver live in this module. The dispatch is an inline `context.run()` step; the callback is a Vercel route at `/api/tracking-callback`. No round-trip to Firebase.
4. **Link delivery** — When the day's KPIs are complete, sends either an optimisation-session link or a new-belief-session link via SMS, depending on the `ritualUsedOut` flag.

It exists as a separate module (and a separate deploy target) because Upstash Workflow + Mastra are first-class on Vercel and only awkwardly hosted on Firebase Functions. The `cloud-functions/` module stays focused on the ritual loop and is unrelated to tracking.

## Parent Project Architecture (Flow)
1. **QStash schedule fires** at 18:00 local (per timezone). Body carries `{ tz: "<IANA tz>", round: "primary" }`. A second schedule fires at 20:00 with `round: "retry"`.
2. **Workflow root run** loads users in that timezone (`rituals.where("timeZone", "==", tz)`), dedups to one user per `userID` (a user may own multiple rituals), and `context.invoke`s a per-user sub-workflow run for each one. Fan-out stays on `rituals` (and not `users`) to avoid having to maintain a "user has at least one active ritual" flag — having a row in `rituals` is the activeness signal.
3. **Per-user run** (idempotent across rounds):
   1. Read `trackingEvents/${userID}_${YYYY-MM-DD}` (date in user's tz). If `allRitualsComplete(doc)` (every ritual's three KPIs non-null) → exit immediately. This is what makes the 20:00 round skip users already covered.
   2. **Inline dispatch step** — `context.run('dispatch-tracking-call', ...)` reads `users/{userID}` (single source of truth — see `cloud-functions` Phase 6) for `phoneNumber`, `language`, `voiceID`, and the `ritualLabels` map. Builds the `rituals: [{ googleDocId, label }]` array from `ritualLabels`. Calls `AgentDispatchClient.createDispatch` against `agentName: "tracking-agent"`. Metadata includes `run_id`, `tracking_callback_url`, and the `rituals` array so the agent walks through each one in conversation.
   3. `context.waitForEvent("tracking-call-result-${runId}", "5m")`. The `tracking-agent`'s shutdown callback posts directly to this module's `/api/tracking-callback`, which writes the merged `trackingEvents` doc (per-ritual monotonic merge) and calls `client.notify` to wake this parked run.
   4. Inspect the event payload:
      - If `conversationHappened === true` AND every ritual's three KPIs are non-null → write final state, send link if needed, exit.
      - Otherwise → fall through to SMS path. The SMS chat picks up only the rituals (and KPIs) still null — the monotonic merge means already-collected ones are sticky.
   5. **SMS chat (Mastra)**: send the opener via Telnyx; for each user reply, the inbound webhook calls `client.notify("sms-reply-${runId}")` and the workflow advances. Mastra's tool calls (keyed by `googleDocId`) write KPI updates back into the workflow's local state. Time-out per turn: 30 minutes; total chat budget: 90 minutes.
   6. After the chat: write merged state to Firestore, send link if needed, exit.
4. **Link delivery**: SMS-only in v1 via Telnyx Programmable Messaging. **Exactly one link per user per day**, decided by precedence over the merged daily doc:
   - any ritual with `ritualUsedOut === true` → `https://cal.com/samuel-giraldo-concha-yqvtot/new-belief`
   - else any ritual with a KPI failure (`relapse === true || ritualFulfilled === false || answeredCall === false`) → `https://cal.com/samuel-giraldo-concha-yqvtot/optimisation`
   - else (all green across all rituals) → no link.

   The precedence collapses cleanly to single-ritual semantics. For multi-ritual users it sends ONE link regardless of how many rituals match: used-out is the rarer + stronger signal so it wins; if none are used-out, any failure across any ritual triggers optimisation; only fully-green days send nothing.

## Parent Project Modules
- `samwise-backend/tracking-agent/` (LiveKit Cloud, deployed) — the voice agent that places the tracking call after this module dispatches it. The agent's shutdown callback POSTs to this module's `/api/tracking-callback`. The connection is one-way and lightweight: dispatch metadata in, HTTP POST out.
- `samwise-backend/cloud-functions/` (Firebase) — UNRELATED to this module. Owns the existing ritual loop (`registerNewRitual`, `checkUsersRituals`, `makeCallsBatchFunction`). It and this module both happen to use the LiveKit API and Firestore, but they share no state and don't call each other for the tracking feature.
- `samwise-backend/my-agent/` — unrelated. Reference only.

## Module Overview
A Next.js project on Vercel — Next.js because it's the easiest deploy target with route handlers (`POST`) that fit Upstash Workflow's `serve()` shape, and because Mastra's documentation defaults to Next.js. We do NOT need any UI; this is an API-only Next.js app (no `app/page.tsx`).

The module exposes four HTTP routes:
- `POST /api/tracking-workflow/root` — invoked by QStash Schedules. Body `{ tz, round }`. Loads users, fans out per-user runs.
- `POST /api/tracking-workflow/per-user` — the per-user run. Invoked by `context.invoke` from the root. Body `{ userID, runId, tz, round }`.
- `POST /api/tracking-callback` — invoked by the deployed `tracking-agent`'s shutdown callback. Body `{ userID, runId, channel: "voice", conversationHappened, ritualKpis: { [googleDocId]: { relapse, ritualFulfilled, answeredCall, ritualUsedOut } } }`. Writes the merged `trackingEvents` doc (per-ritual monotonic merge), calls `client.notify("tracking-call-result-${runId}", ...)` to wake the parked workflow run.
- `POST /api/sms-inbound` — Telnyx inbound message webhook. Verifies signature, extracts the user phone, finds the active run via the user's currently-parked event ID (stored in a tiny Firestore index doc), calls `client.notify`.

It also contains a one-shot setup script (`scripts/sync-schedules.ts`) that creates / updates QStash Schedules. Run it on every deploy via a Vercel build step or manually. The script is idempotent (uses stable `scheduleId`s).

## Module Structure (Directories and files)
Anticipated layout once Phase 1 lands:

```
samwise-backend/tracking-workflow/
├── app/
│   └── api/
│       ├── tracking-workflow/
│       │   ├── root/route.ts                # QStash → fan-out workflow
│       │   └── per-user/route.ts            # Per-user state machine (incl. inline dispatch step)
│       ├── tracking-callback/route.ts       # Voice agent shutdown-callback receiver
│       └── sms-inbound/route.ts             # Telnyx inbound webhook
├── lib/
│   ├── firestore.ts                         # Lazy-singleton Firebase Admin init
│   ├── livekit.ts                           # Lazy-singleton AgentDispatchClient
│   ├── telnyx.ts                            # SMS send + signature verification
│   ├── chat-agent.ts                        # Mastra agent for the SMS fallback
│   ├── tracking-events.ts                   # Read/merge `trackingEvents` doc helpers (single writer for both voice + SMS paths)
│   └── links.ts                             # Hardcoded cal.com URLs + decision logic
├── scripts/
│   └── sync-schedules.ts                    # `pnpm tsx scripts/sync-schedules.ts`
├── context-for-code-agent.md                # This file
├── current-plan.md                          # Active plan
├── package.json
├── tsconfig.json
├── next.config.js
├── vercel.json                              # Optional: env wiring, build hooks
└── .env.example
```

## Data Management
This module READS from `rituals` (to fan out by timezone and to grab phone numbers for SMS) and WRITES to `trackingEvents` and `users`. It never writes to `rituals`.

### `trackingEvents` document (canonical reference — owned by this module)
Top-level collection. One document per user per local-day, keyed by `${userID}_${YYYY-MM-DD}` where the date is computed in the user's `timeZone`. KPIs are tracked **per ritual** (Option C — see `tracking-agent/src/current-plan.md` Phase 6 for the conversation flow). Idempotency anchor: the 20:00 round of the workflow exits early if every ritual's three KPIs are non-null. Fields:
- `userID: string`
- `date: string` — `YYYY-MM-DD` in the user's timezone.
- `timeZone: string`
- `ritualKpis: { [googleDocId: string]: { relapse: boolean | null, ritualFulfilled: boolean | null, answeredCall: boolean | null, ritualUsedOut: boolean } }` — One entry per ritual the user owned at dispatch time. Initialized lazily by `mergeFinal()` from the dispatch metadata's `ritual_ids` (every ritual the user owned the moment the dispatch was built). Each KPI starts `null` and flips once via the monotonic-merge invariant; `ritualUsedOut` defaults to `false`.
- `followUpSent: 'optimisation' | 'new-belief' | null` — Set by the workflow when it dispatches the SMS link. See `lib/links.ts` precedence: any `ritualUsedOut === true` → `new-belief`; else any KPI failure across any ritual → `optimisation`; else `null`.
- `attempts: Array<{ ts: Timestamp, channel: 'voice' | 'sms', conversationHappened: boolean, partial: object }>` — Append-only audit log of every workflow round that touched this user today. `partial` carries the incoming `ritualKpis` partial as posted by the agent or SMS chat.
- `completedAt: Timestamp | null` — Set the first moment **every** ritual's three KPIs become non-null. With multi-ritual users this is later than for single-ritual users; that's expected.

Two write paths exist within this module — `/api/tracking-callback` (voice) and the per-user route's SMS finalization step. Both go through `lib/tracking-events.ts`'s `mergeFinal()`. Single writer, two callers. No external module writes here.

### The monotonic-merge invariant

`mergeFinal()` enforces one rule, applied **per `(googleDocId, kpiField)`**: **a KPI field can only flip from `null` to `boolean`. Never `boolean` → `null`. Never one `boolean` → a different `boolean`.**

"Monotonic" = only moves one direction (like a stopwatch — counts up, never resets). "Merge" = combining a partial update into an existing record. "Invariant" = a rule that always holds in this codebase. The keying-by-googleDocId means each ritual's KPIs are independent: collecting `ritualA.relapse` doesn't affect `ritualB.relapse`.

**Worked example.** Day-in-the-life of `trackingEvents/u_123_2026-05-05` for a user with two rituals (`docA`, `docB`):

| Step | What happens | Doc state after (`ritualKpis` only; other fields elided) |
|---|---|---|
| 0 | doc doesn't exist | `(missing)` |
| 1 | 18:00 voice call. Agent walks through both rituals; user answers all 3 KPIs for `docA`, then hangs up before `docB`. Agent posts `{ritualKpis: { docA: {relapse:false, ritualFulfilled:true, answeredCall:true, ritualUsedOut:false}, docB: {relapse:null, ritualFulfilled:null, answeredCall:null, ritualUsedOut:false} }}` | `{ docA: <complete>, docB: <all null> }` |
| 2 | Workflow checks: `docB` has 3 KPIs still `null` → schedule SMS. Opener sent. | unchanged |
| 3 | User replies on SMS: "ritual B yes, no relapse on B." Mastra's tools fire with `googleDocId: "docB"`. Workflow merges `{ritualKpis: { docB: {ritualFulfilled:true, relapse:false} }}`. | `{ docA: <complete>, docB: {relapse:false, ritualFulfilled:true, answeredCall:null, ritualUsedOut:false} }` |
| 4 | 20:00 cron fires. Workflow re-checks: `docB.answeredCall` still `null` → dispatch second voice call. User says "yes, I answered the call about B." Agent posts `{ritualKpis: { docA: {…all null…}, docB: {answeredCall:true, others:null} }}` (fresh session — in-memory state for already-collected KPIs is `null`). | `{ docA: <complete>, docB: <complete> }`, `completedAt` set |

Step 4 is the load-bearing case. **Without the invariant**, a naive `Object.assign` would overwrite `docA`'s collected booleans with `null` from the second call's fresh state — silently destroying data we already collected. **With the invariant**, the merge skips `null` partials per-key and only sets `(googleDocId, kpiField)` pairs still `null` in the existing doc. Step 4's effective contribution is just `{ docB: { answeredCall: true } }` — exactly what we want.

**Rule in code (planned for `lib/tracking-events.ts`):**
```ts
type KpiBundle = {
  relapse: boolean | null;
  ritualFulfilled: boolean | null;
  answeredCall: boolean | null;
  ritualUsedOut: boolean;
};

export function mergeFinal(
  existing: TrackingEvent | null,
  incoming: Partial<TrackingEvent> & { ritualIds?: string[] },
): TrackingEvent {
  const doc =
    existing ??
    freshDoc(incoming.userID!, incoming.date!, incoming.timeZone!, incoming.ritualIds ?? Object.keys(incoming.ritualKpis ?? {}));

  // Initialize any missing ritual entries (lets late-arriving partials still seed a ritual).
  for (const id of Object.keys(incoming.ritualKpis ?? {})) {
    if (!doc.ritualKpis[id]) doc.ritualKpis[id] = freshKpiBundle();
  }

  for (const [id, bundle] of Object.entries(incoming.ritualKpis ?? {})) {
    const target = doc.ritualKpis[id];
    for (const k of ['relapse', 'ritualFulfilled', 'answeredCall'] as const) {
      // Only flip null → boolean per-(ritual, field). Never overwrite an existing boolean.
      if (target[k] === null && bundle[k] !== null && bundle[k] !== undefined) {
        target[k] = bundle[k]!;
      }
    }
    // ritualUsedOut: one-way OR per ritual. false → true is sticky; true never reverts.
    if (bundle.ritualUsedOut === true) target.ritualUsedOut = true;
  }

  // attempts: append-only audit log; never collapsed.
  doc.attempts.push({ ts: Timestamp.now(), ...incoming });

  // completedAt: set the FIRST moment EVERY ritual's three KPIs are non-null.
  if (doc.completedAt === null && allRitualsComplete(doc)) doc.completedAt = Timestamp.now();
  return doc;
}
```

`freshDoc` initializes `ritualKpis` from the dispatch's `ritual_ids` so the doc has a stable shape from the first write. The dispatch metadata is the canonical "rituals at dispatch time" snapshot — late ritual additions are picked up by tomorrow's run, not today's.

**What the invariant enables:**
1. **Single-fire POST from the agent.** Re-posting the same data is a no-op (already-non-null fields are sticky), so the agent doesn't need a retry loop in its shutdown callback.
2. **Channel-agnostic writes.** Voice and SMS paths write to the same doc without coordinating. Whichever channel collects a `(ritual, KPI)` first wins; the other just no-ops on that pair.
3. **No timestamp / version-vector logic.** Some systems use last-write-wins with vector clocks. We don't need any of that — the merge rule itself encodes the right answer.
4. **Per-ritual independence.** Collecting `ritualA.relapse` does not affect any field on `ritualB`. The invariant is local to each `(ritual, KPI)` cell, so a multi-ritual conversation that times out partway through is just as safe as one that completes — the cells it filled stick; the rest stay `null` for the next channel.

**Trade-off you should know about.** The strict rule means *"first-collected value wins; contradictions in later channels are silently ignored."* If voice records `docA.ritualFulfilled: true` and the user later texts "wait no, I didn't on A," the SMS won't override. For v1 this is intentional — the workflow shouldn't be re-asking already-collected KPIs anyway, and the `attempts` array preserves every attempt so disputes are debuggable. If v2 ever needs user-correctable answers, add an explicit "correct" tool path that bypasses `mergeFinal()`.

### `users` document
**Owned by `cloud-functions/registerNewRitual`** (see `cloud-functions/functions/src/current-plan.md` Phase 6). This module READS `users/{userID}` for dispatch metadata (phone, language, voiceID, timezone, `ritualLabels`) and merge-WRITES exactly one tracking-only field: `lastTrackingEventAt: serverTimestamp()` (set in Phase 5's finalization step). All other user-level fields are read-only from this module's perspective.

The `ritualLabels` map (`{ [googleDocId]: string }`) is the source of truth for the per-ritual list passed to `tracking-agent` in dispatch metadata as `rituals`. The agent uses these labels conversationally so the user recognizes which ritual is being asked about.

Trust assumption: `users/{userID}` always exists by the time this module touches a user, because tracking is gated by ritual ownership and ritual registration is what creates the user doc. If a `users` doc is missing for a userID returned by the timezone fan-out, the per-user route soft-skips: it logs a warning and exits cleanly. The first version threw a hard error and accumulated 3× Upstash retries per stale `rituals` row, which was noisy in the dashboard whenever seed/test data lacked a matching `users` doc. Don't fabricate a missing doc upstream either — fix the seed data.

The per-user route also reads the optional `behaviorLabels: { [googleDocId]: string }` map from the same doc. This is the short, conversational name (e.g. `"morning meditation"`) used by both the voice agent and the SMS chat agent in their user-facing speech. Falls back to the verbatim `ritualLabels[googleDocId]` (the Google Doc title) when missing — populated by `cloud-functions/registerNewRitual` from Gemini's synthesis output as of 2026-05-06.

### Workflow-internal index (small Firestore helper doc)
`smsActiveRuns/{phoneNumber}` → `{ runId, userID, eventDocId, startedAt, expiresAt }`. Written when the workflow enters the SMS chat phase (in `record-active-sms-run`), deleted when the chat ends or expires (`clear-active-sms-run`). The inbound webhook (`/api/sms-inbound`) reads this to map an inbound phone number back to the parked workflow run, then calls `client.notify('sms-reply-${runId}', { from, body })` to wake it. Cheap; expected size is the count of users currently in the SMS chat phase, bounded by daily active users in the worst case.

## Mastra SMS Chat Agent (`lib/chat-agent.ts`)
Inline Mastra agent — built fresh per turn inside `runChatTurn()` rather than registered to a `new Mastra({ agents: { ... } })` instance. No `getAgentById`, no Mastra Studio wiring; the workflow already owns the canonical state (the `trackingEvents` doc) and we don't need shared memory or observability for a one-shot generate. If we ever want Studio for debugging, we register the agent under a Mastra instance and run `npm run dev` from a `mastra/` subdir — easy retrofit.

Model: `google/gemini-2.5-flash` via Mastra's model router. Pinned to 2.5-flash for the same reason `tracking-agent` is — `gemini-3-flash-preview` requires `thought_signature` on follow-up function-call parts, which the Vercel AI SDK / Mastra wrapper doesn't propagate, breaking multi-tool turns. Mastra reads Google credentials from `GOOGLE_GENERATIVE_AI_API_KEY`; `chat-agent.ts` mirrors `process.env.GOOGLE_API_KEY` to that name at module load so we share one Vercel env var.

Tools (closures over a per-turn `state` object):
- `recordKPI({ googleDocId: string, field: 'relapse' | 'ritualFulfilled' | 'answeredCall', value: boolean })` — sets `state.kpiUpdates[googleDocId][field] = value`.
- `markRitualUsedOut({ googleDocId: string })` — sets `state.kpiUpdates[googleDocId].ritualUsedOut = true`.
- `complete()` — sets `state.done = true`. Does NOT call `client.notify`; the workflow loop reads `done` from the returned `ChatTurnResult` and exits.

Each inbound user reply drives ONE Mastra invocation (`agent.generate(reply, { maxSteps: 2 })`). The workflow:
1. Computes `remaining` rituals from the latest merged doc via `computeRemaining()` so the agent never re-asks for an already-collected KPI.
2. Calls `runChatTurn({ language, remaining, userReply })`.
3. Persists `state.kpiUpdates` via `mergeFinal()` if non-empty.
4. Sends `state.message` via Telnyx if non-empty.
5. Loops to next reply unless `state.done` or `allRitualsComplete(merged)`.

The workflow holds the SMS turn budget (`TURN_BUDGET = 6`) and per-turn timeout (`30m`). Mastra is doing the LLM-side conversation logic only; orchestration stays in `lib/workflows/per-user.ts`.

## Telnyx Integration (`lib/telnyx.ts`)
- **Outbound:** `client.messages.send({ to, from: process.env.TELNYX_FROM_NUMBER, text })` via the official `telnyx` SDK (lazy-singleton). Phone-number sender (no alpha sender) so the user can reply — the Phase 4 chat loop relies on two-way SMS. Same Telnyx account as SIP voice; the Messaging Profile is a separate setup step in Mission Control.
- **Inbound:** Telnyx posts JSON to `/api/sms-inbound`. The route reads the raw body string, then calls `verifyInboundSignature(rawBody, headers)` which delegates to `TelnyxWebhook.verify()` (Ed25519 against `TELNYX_PUBLIC_KEY`, the base64 key from Mission Control → Messaging Profiles → Public Key). Rejected requests return 401. After verification the route filters for `event_type === 'message.received'`, looks up `smsActiveRuns/{phoneNumber}`, and calls `workflowClient().notify('sms-reply-${runId}', { from, body: text })`. Inbound from a phone with no active run is logged + dropped (v2 will handle proactive-inbound).

## Environment Variables
- `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_URL` — Upstash auth + workflow request verification. Auto-injected per environment scope by the Vercel ↔ Upstash integration. Pulling local with `vercel env pull --environment=production .env.local` is mandatory before triggering against prod (dev keys won't validate prod signatures).
- `FIREBASE_SERVICE_ACCOUNT_JSON` — base64-encoded service account for Firebase Admin SDK (Vercel doesn't mount JSON files; decode in `lib/firestore.ts`).
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — for `AgentDispatchClient.createDispatch` against the deployed `tracking-agent`. Same project as `narya-agent` and `tracking-agent` (`arbor-a93j2951`).
- `TELNYX_API_KEY` — bearer token for outbound `messages.send`.
- `TELNYX_PUBLIC_KEY` — base64 Ed25519 key from Mission Control; verifies inbound webhook signatures.
- `TELNYX_FROM_NUMBER` — E.164 phone number on the Messaging Profile (e.g. `+15079201622`). Phone-number sender (NOT alpha sender) so users can reply.
- `TRACKING_CALLBACK_URL` — absolute URL of this deployment's `/api/tracking-callback`, embedded in dispatch metadata so the agent knows where to POST. Set per-environment in Vercel; today this is `https://samwise-tracking.vercel.app/api/tracking-callback`.
- `GOOGLE_API_KEY` — Gemini key shared with `narya-agent` and `cloud-functions`. `lib/chat-agent.ts` mirrors this to `GOOGLE_GENERATIVE_AI_API_KEY` at module load so Mastra finds it. Don't set both.

## Style Reference
Inherits the parent project's `programming-style.md` Shared TypeScript Idioms section verbatim:
- **Pragmatic Safety** — `process.env.X!` for known env vars at module load, scoped interfaces inside route handlers.
- **Lazy Singletons** — `lib/firestore.ts` initializes Firebase Admin behind an `initialized` flag; same for the QStash client.
- **Lookup Tables** — link decision and follow-up message text use object-literal lookup keyed by `(ritualUsedOut, anyKpiFailed)` rather than nested if/else.
- **Scoped Interface Declaration** — declare request/response shapes inside each route handler.

Mastra and Upstash Workflow patterns are not yet covered by the parent style guide. As patterns settle in this module, they should be promoted into a future module-level `programming-style.md` and eventually back into the parent — but only after they've been used at least once and proven stable. Don't write the style guide before the code.

## What This Module Does NOT Do
- Does not host the agent runtime. The voice agent runs in `tracking-agent/` on LiveKit Cloud. This module just dispatches it via `AgentDispatchClient` and receives its shutdown callback.
- Does not write to `rituals`. Read-only on that collection.
- Does not handle proactive-inbound SMS in v1. The inbound webhook only acts on phones with an active workflow run (i.e., a row in `smsActiveRuns`). Inbound from any other phone is logged and dropped. A future "v2" phase tracked in `current-plan.md` adds proactive support.
- Does not manage WhatsApp. SMS-only via Telnyx in v1. The provider abstraction in `lib/telnyx.ts` is single-function — easy to swap later if WhatsApp/Meta becomes worth the approval cost.
- Does not call into `cloud-functions/`. The two modules share Firestore and the LiveKit project but have no direct HTTP relationship.
