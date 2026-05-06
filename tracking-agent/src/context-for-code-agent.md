# Code Agent Context for the `tracking-agent` Module

## Parent Project Overview
This module is a sibling of `samwise-backend/my-agent/`. It is a second LiveKit Agents (Node.js) project, voice-only, deployed independently to LiveKit Cloud via its own Dockerfile. It exists to handle the **tracking-call** feature: a short outbound voice call that asks the user three questions about their day (relapse, ritual fulfillment, whether they answered the morning coaching call) and POSTs the result back to the orchestrating Vercel deployment (`tracking-workflow`). It deliberately does NOT reuse `my-agent`'s instructions or tools — the conversation goal is fundamentally different (retrospective tracking vs. live coaching) and mixing them in one agent would only invite drift.

## Parent Project Architecture (Flow)
1. **`tracking-workflow` (Vercel)** triggers a per-user run when a QStash schedule fires at 18:00 or 20:00 local time.
2. **`tracking-workflow`'s per-user route** runs an inline `context.run('dispatch-tracking-call', ...)` step that loads the user's ritual from Firestore, builds metadata (`phone_number`, `language`, `voice_id`, `user_id`, `run_id`, `tracking_callback_url`), and calls `AgentDispatchClient.createDispatch` against `agentName: "tracking-agent"`. No HTTP hop to Firebase.
3. **`tracking-agent` (this module)** picks up the dispatch, places the SIP call via the existing Telnyx outbound trunk, asks the three questions in the user's language, and on shutdown POSTs the collected answers to the URL embedded in `metadata.tracking_callback_url` — which points at `tracking-workflow`'s `/api/tracking-callback` route on Vercel.
4. **`tracking-workflow/api/tracking-callback`** writes/merges the daily `trackingEvents/${userID}_${YYYY-MM-DD}` doc and notifies the parked Upstash Workflow via `client.notify("tracking-call-result-${runId}")`.

### Picture
```
tracking-agent (LiveKit Cloud)              tracking-workflow (Vercel)
─────────────────────────────              ─────────────────────────────
in-memory state ── shutdown ──fetch──►  /api/tracking-callback
                              (1 try)        │
                                              ├── mergeFinal() ──► Firestore (monotonic)
                                              └── client.notify ──► resumes parked workflow
                                                                          │
                                                                          ├── voice complete? send link, exit
                                                                          └── voice incomplete OR 5m timeout?
                                                                              → SMS path picks up missing KPIs
                                                                              → mergeFinal() composes them in
```

The agent is a "fire and forget" producer: it builds an in-memory state object as the user answers, then on session shutdown does ONE `fetch` POST to the callback URL and exits. No retries, no Firestore — both responsibilities belong to `tracking-workflow`. See `mergeFinal()` discussion in `tracking-workflow/context-for-code-agent.md` for the monotonic-merge invariant that lets a single-fire POST be safe.

## Parent Project Modules
The tracking voice path lives in this single module. Sibling modules:
- `samwise-backend/tracking-workflow/` (Vercel) — owns the cron, the per-user state machine, the inline LiveKit dispatch step, the `/api/tracking-callback` receiver, the SMS fallback chat (Mastra), and the link sender (Telnyx SMS). Talks to this module exclusively via the dispatch metadata contract documented below.
- `samwise-backend/cloud-functions/` (Firebase) — UNRELATED to this module. Owns the existing ritual loop. The original plan to put `dispatchTrackingCall` / `trackingCallback` here was reverted because it added two unnecessary HTTP hops; both responsibilities now live in `tracking-workflow`.
- `samwise-backend/my-agent/` — the existing morning-coaching agent. Reference for SDK patterns, dispatch metadata shape, and the turn-counter / shutdown-callback pattern. Do NOT import from it; copy patterns.

## Module Overview
This module is a fresh `lk agent init` clone of the `agent-starter-node` template (the same template `my-agent/` was bootstrapped from), customized to:
- Replace the starter `instructions` with a tracking-specific system prompt that asks the three KPIs in order and supports the `ritualUsedOut` exception.
- Replace the example tools with three Zod-validated tools that record each KPI as the user answers, plus a `markRitualUsedOut` tool for the exception path.
- Track `userTurnCount` in the entry scope (the existing project's "Lifecycle State Capturing" pattern from `programming-style.md`) and use it as the source of truth for `conversationHappened`. Do NOT rely on LiveKit's call-status / answered events — the morning agent's `leaveVoicemail` pattern is wired the same way and it's the convention here.
- On `addShutdownCallback`, POST `{ userID, runId, channel: "voice", conversationHappened, relapse, ritualFulfilled, answeredCall, ritualUsedOut }` to the `tracking_callback_url` from dispatch metadata. The agent itself never writes Firestore; the workflow's `/api/tracking-callback` is the single writer for the voice path.

## Module Structure (Directories and files)
Anticipated layout once Phase 1 lands. Mirrors `my-agent/` to keep cognitive overhead low.

```
samwise-backend/tracking-agent/
├── src/
│   ├── main.ts                     # Entry, dispatch metadata parse, session bootstrap
│   ├── agent.ts                    # Agent class with instructions + Zod-tool definitions
│   ├── agent.test.ts               # LiveKit Agents test harness (per AGENTS.md TDD rule)
│   ├── context-for-code-agent.md   # This file (will move here once src/ exists)
│   ├── current-plan.md             # Active plan (will move here once src/ exists)
│   └── programming-style.md        # Module-level style (LiveKit Agents patterns from parent)
├── Dockerfile                      # LiveKit Cloud production image
├── package.json                    # pnpm; mirrors my-agent's deps
├── tsconfig.json
├── eslint.config.ts
├── AGENTS.md                       # Coding-agent guide (copied from my-agent's AGENTS.md verbatim, then update title and any agent-specific notes)
├── README.md
└── .env.example                    # LIVEKIT_URL / KEY / SECRET, SIP_OUTBOUND_TRUNK_ID
```

## Dispatch Metadata Contract
Built by `tracking-workflow`'s per-user route inside the `dispatch-tracking-call` step (uses `AgentDispatchClient.createDispatch`); parsed in `main.ts`:
```ts
{
  user_id: string,
  phone_number: string,
  language: string,                  // raw language name (e.g. "English", "Español") — written into instructions
  voice_id: string,
  room_name: string,
  run_id: string,                    // Upstash Workflow run ID (context.workflowRunId); echoed in callback
  tracking_callback_url: string,     // absolute URL of tracking-workflow's /api/tracking-callback
  rituals: Array<{                   // Per-ritual list. Walked through in order during the conversation.
    googleDocId: string,             //   Stable identifier; agent passes it back in tool calls and the shutdown POST.
    label: string,                   //   Human-readable label (Google Doc title) — agent uses it to refer to the ritual conversationally.
  }>,
}
```

Why `tracking_callback_url` is in the metadata rather than an env var: avoids hardcoding the workflow's URL into the agent's image, which means rotating the workflow deploy (or running per-PR Vercel previews) doesn't require redeploying the LiveKit agent.

Why `rituals` is a list (not a single ritual): a user may own multiple active rituals. The agent walks through each one in turn, asking the same three KPIs per ritual. The `label` is the Google Doc title (sourced upstream by `cloud-functions/registerNewRitual` — see Phase 6 there) and is what the user recognizes; the agent must refer to rituals by label, not by `googleDocId`. The list is built from `users/{userID}.ritualLabels` by `tracking-workflow`, so the `users` doc is the single upstream source of truth.

## Conversation Goals (for the system prompt)
The instructions string (drafted in `current-plan.md` Phase 6) must:
- Greet briefly, in the user's language, and identify itself as a short check-in (NOT a coaching session — this is the most likely point of confusion with `my-agent`).
- Walk through the user's rituals in dispatch order. For each ritual referred to by its `label`, ask the three KPIs in this fixed order: (1) ritual fulfillment, (2) relapse, (3) whether they answered the morning call for that ritual. The order is intentional — fulfillment is the easiest to answer and warms up the conversation; relapse is the most sensitive; "did you answer the call" is meta and least intrusive last.
- The agent must always refer to rituals by their `label` (Google Doc title), never by `googleDocId`. The user knows their ritual by the title their therapist named it.
- Tool calls always include the `googleDocId` of the ritual being asked about, so the entry-scope state can record per-ritual answers.
- Listen for the "I solved it" exception per ritual ("I don't need this one anymore", "this ritual isn't a problem for me anymore", language equivalents). When detected for a ritual, call `markRitualUsedOut({ googleDocId })` and move on to the next ritual; do NOT terminate the entire call (other rituals may still need answering).
- Cap each KPI question at ~3 turns. Do not re-ask if the user gave an unambiguous answer.
- End the call as soon as every ritual has all three KPIs recorded OR is marked `ritualUsedOut`.

## Tool Contract
All tools use Zod schemas for parameters and write to a per-session state object held in entry scope (NOT Firestore — Firestore is written by `tracking-workflow/api/tracking-callback`). Every tool takes a `googleDocId` so per-ritual state stays disambiguated.
- `recordRelapse({ googleDocId: string, value: boolean })`
- `recordRitualFulfilled({ googleDocId: string, value: boolean })`
- `recordAnsweredCall({ googleDocId: string, value: boolean })` — refers to the morning coaching call **for this specific ritual**.
- `markRitualUsedOut({ googleDocId: string })` — sets `ritualKpis[googleDocId].ritualUsedOut = true`. Implies the conversation goal for *that ritual* is met; agent should move on to the next ritual or wrap up if it was the last.

## Lifecycle State (entry scope)
Mirroring the parent style guide's "Lifecycle State Capturing" pattern, now keyed per-ritual:
```ts
type KpiBundle = {
  relapse: boolean | null;
  ritualFulfilled: boolean | null;
  answeredCall: boolean | null;
  ritualUsedOut: boolean;
};

let userTurnCount = 0;
const ritualKpis: Record<string, KpiBundle> = Object.fromEntries(
  metadata.rituals.map(r => [r.googleDocId, {
    relapse: null, ritualFulfilled: null, answeredCall: null, ritualUsedOut: false,
  }]),
);

session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
  if (ev.item.role === 'user') userTurnCount++;
});

ctx.addShutdownCallback(async () => {
  await fetch(metadata.tracking_callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userID: metadata.user_id,
      runId: metadata.run_id,
      channel: 'voice',
      conversationHappened: userTurnCount > 0,
      ritualKpis,
    }),
  });
});
```
The shutdown callback runs whether the call ended naturally, hung up, hit voicemail, or errored. `userTurnCount > 0` is the canonical "did a real conversation happen?" signal — voicemail recordings rarely produce user turns; a real conversation always does. The receiver (`/api/tracking-callback`) applies the per-`(googleDocId, KPI)` monotonic merge, so re-posting `null` for already-collected fields is a no-op — partial conversations across multiple rituals are safe.

## Environment Variables
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — LiveKit Cloud credentials.
- `SIP_OUTBOUND_TRUNK_ID` — Telnyx outbound trunk; same value as `my-agent`.
- LLM/voice provider keys per LiveKit Inference, same setup as `my-agent`.

No Firebase credentials needed in this module — Firestore writes happen in `tracking-workflow/api/tracking-callback`. Keep the agent stateless w.r.t. our DB.

## Style Reference
Follow the parent project's `programming-style.md` LiveKit Agents section verbatim:
- **XML-Tagged Structural Prompting** — instructions use `<personality>`, `<environment>`, `<tone and style>`, `<goal>` tags.
- **Zod-Validated Tooling** — every tool has a `z.object` schema; never pass raw strings into the function body.
- **Lifecycle State Capturing** — `let` variables in entry scope, mutated in event listeners, read in `addShutdownCallback`. This is the source of truth for `conversationHappened`.

## What This Module Does NOT Do
- Does not write to Firestore. Ever. All persistence is via the workflow's `/api/tracking-callback`.
- Does not send SMS. The fallback path is the workflow's job, not the agent's.
- Does not schedule calls. QStash schedules → workflow's per-user route → inline `AgentDispatchClient.createDispatch` is the chain.
- Does not call into `cloud-functions/`. Unrelated module.
- Does not import code from `my-agent/`. Copy patterns; do not couple modules.
