# context-for-code-agent.md — observability

> **What this module is.** Observability is a *cross-cutting initiative*, not a single deployable.
> Its HQ (this folder) holds the working files + the canonical tagging contract. The actual code
> lands in four existing modules: `ritual-agent`, `tracking-agent` (trace emission), `cloud-functions`
> (the judge), and `samwise-app` (the cockpit). Langfuse Cloud is the managed trace store.

## Parent Project Overview

Samwise helps users overcome behavioural challenges via clinicians + AI voice/text agents that
follow up through scheduled "ritual" calls. Services: Firebase cloud functions, three LiveKit voice
flows (qualification / onboarding / call) under `ritual-agent`, a `tracking-agent`, the Vercel
`tracking-workflow`, the operator app `samwise-app`, and the public `samwise-landing`.

## Parent Project Architecture (Flow)

Prospect → `samwise-landing/qualify` (Nova qualification, WebRTC) → `qualifications/` in Firestore
→ Breakthrough Call → Call Design Session (`ritual-agent` onboarding, WebRTC) → `registerNewRitual`
writes `rituals/` → scheduler cron dispatches `ritual-agent` `call` flow (SIP) → `tracking-agent` +
`tracking-workflow` capture `trackingEvents/`. Every LLM-driven conversation in that chain is what
observability must see.

## Parent Project Modules (and what each emits)

- `samwise-backend/ritual-agent/` — 3 WebRTC/SIP flows. **Emits conversations** (the primary target).
- `samwise-backend/tracking-agent/` — tracking call. **Emits conversations.**
- `samwise-backend/cloud-functions/` — single `functions/src/index.ts` (2.6k lines). Hosts the new
  `evaluateConversation` judge. Existing LLM functions (extract*, clean*, suggest*) are trace-able later.
- `samwise-backend/tracking-workflow/` — Vercel SMS orchestration (`sms-chat-agent`, Mastra). Text conversations; trace later.
- `samwise-app/` — operator app on Vercel; **hosts the `/observability` cockpit**. Has `lib/firebase-admin.ts`.
- `samwise-landing/` — already traced to Langfuse via `instrumentation.ts` (text-mode qualify chat only).

## Module Overview — observability

Hybrid design (microscope + control tower):

1. **Langfuse = trace spine (microscope).** Every conversation becomes a session-grouped trace.
   Agents export OTel spans to Langfuse via `setTracerProvider` from `@livekit/agents/telemetry`
   (the framework auto-emits LLM/turn spans). The landing already exports its AI-SDK spans.
2. **`evaluateConversation` judge = online eval.** At end-of-call the worker POSTs the transcript +
   metadata to this cloud function. An LLM grades it against three criteria — **off-script/off-persona,
   call-failure, goal-not-met** (safety/distress intentionally deferred) — and writes a compact verdict
   to `conversationEvals/` in Firestore. Mirrors the existing `extractQualification` pattern exactly.
3. **`/observability` cockpit (control tower) in samwise-app.** Reads Firestore: funnel
   (`qualifications`/`rituals`/`calendarBookings`/`trackingEvents`/`demoCalls`), system health
   (failed/no-answer/short calls), and the **flagged-call triage queue** (`conversationEvals`), each
   row deep-linking into its Langfuse session.

**Why this shape:** the next project (`EVALS AND LOAD TEST SUITE`) drives our agents through their
web entry points with randomized prompt variants to catch errors pre-prod. Building observability
this way means those synthetic sessions reuse the same tracing (tagged `synthetic`), the same judge,
and the same `prompt_variant` dimension — the load-test suite inherits its plumbing for free.

## Module Structure (Directories and files)

```
samwise-backend/observability/            # HQ (this folder) — no deploy; docs + canonical contract
├── context-for-code-agent.md             # this file
├── current-plan.md                       # active phased plan
└── observability-contract.ts             # CANONICAL ObsMeta type + buildLangfuseAttributes() + tag consts
                                          #   → MIRRORED into each agent as src/config/observability.ts
```

Code that lands elsewhere (created/edited by the plan):
```
ritual-agent/src/config/observability.ts  # mirror of the contract
ritual-agent/src/main.ts                   # setTracerProvider wiring (once, at worker init)
ritual-agent/src/flows/*/index.ts          # per-call attrs + end-of-call eval POST
tracking-agent/src/...                      # same two edits
cloud-functions/functions/src/index.ts      # + evaluateConversation, + EVAL_JUDGE_PROMPT
samwise-app/app/observability/page.tsx       # the cockpit
samwise-app/lib/observability/*.ts            # Firestore aggregation + Langfuse deep-link helpers
samwise-landing/app/api/qualify/chat/route.ts # add synthetic + flow tags to existing telemetry
```

## Conventions specific to this module

### The tagging contract (load-bearing — this is what lets the load-test suite plug in)

Every traced conversation carries the same metadata, set as Langfuse-recognized OTel span attributes.
Canonical keys (verified against Langfuse OTel mapping):

| Concept | OTel attribute key | Value |
|---|---|---|
| Session grouping | `langfuse.session.id` | the LiveKit **room name** (`ctx.room.name`) — unique per call, available everywhere |
| Tags | `langfuse.trace.tags` | `["flow:<flow>", "lang:<es\|en>", "<prod\|synthetic>", "variant:<id>"]` |
| Trace name | `langfuse.trace.name` | `"<flow> call"` |
| Per-key metadata | `langfuse.trace.metadata.<k>` | `flow`, `language`, `prompt_variant`, `synthetic`, `prospectKey` |

`synthetic` defaults to `false`. The load-test suite will set it `true` so synthetic runs never
pollute the funnel cockpit (the cockpit filters `synthetic !== true`). `prompt_variant` defaults to
`"default"`; the load-test suite varies it so error rates compare across variants in Langfuse.

### Correlation key = room name

A conversation's Langfuse session id, the `conversationEvals/{id}.sessionId` field, and the cockpit
deep-link are all the **LiveKit room name**. Don't invent a second id.

### Langfuse is one shared project

Agents, cloud functions, and the landing all export to the **same** Langfuse project (one
`LANGFUSE_*` key set). One pane of glass. Reuse the landing's existing project + keys.

### Mirror, don't import

`observability-contract.ts` is duplicated into each agent (separate pnpm projects, no workspace) per
the repo's existing MIRROR convention (cf. `qualification/schema.ts`). Change one → change all.

### The judge mirrors extractQualification

`evaluateConversation` copies the `extractQualification` shape verbatim: `onRequest({cors:true,
timeoutSeconds:120})`, inline interfaces, `GoogleGenerativeAI(requireEnv("GEMINI_KEY"))`,
`responseMimeType:"application/json"`, `getFirestore().collection("conversationEvals")`. Don't
introduce a new LLM client or framework.

### Recent Changes

- **2026-06-04 — REVERTED to a clean slate; re-planned from scratch.** The 2026-05-31 attempt
  (`tracing.ts`/`observability.ts` + wiring + deps) was reverted — only this HQ folder + the `.env.local`
  keys survive. Fresh plan in `current-plan.md`. Two things changed vs. the reverted attempt:
  1. **Tagging mechanism FIXED.** Do NOT use `setTracerProvider(p, {metadata})` — it calls OTel **v1**
     `addSpanProcessor`, removed in the **v2** provider `@langfuse/otel` forces → it crashed every flow on
     entry. Correct v2 mechanism (doc-verified via the `langfuse` skill): a **custom `SpanProcessor` that
     stamps the `langfuse.*` attrs on every span in `onStart`** (reading a per-job ref), added at provider
     construction; OTel **Baggage** is the concurrency-safe upgrade if concurrent jobs on one worker
     cross-contaminate. Register the provider with `telemetry.setTracerProvider(provider)` — no metadata.
     Always wrap tracing non-fatal.
  2. **Scope is now 5 flows** (`main.ts` routes `call`/`onboarding`/`qualification`/`demo-call`/`scribe`),
     not 3 — observability covers all conversational flows.
- For all Langfuse docs/API/CLI work use the `langfuse` skill (rule: never implement from memory — verify
  against current docs). Phase 2's judge follows its `judge-calibration.md`; triage follows `error-analysis.md`.
