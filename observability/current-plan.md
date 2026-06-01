# current-plan.md — Observability (dashboard + online eval suite)

## Status (2026-05-31)

- ✅ **Phase 0 Step 2** — contract mirrored to `ritual-agent/src/config/observability.ts`; deps installed
  (`@langfuse/otel@5.4.1`, `@opentelemetry/sdk-trace-node@2.7.1`, `@opentelemetry/api@1.9.1`).
- ⚠️ **Phase 1 base tracing works; per-call TAGGING is broken (OPEN).** `config/tracing.ts` +
  `main.ts` prewarm `initTracing()` + qualification `applyConversationTracing()` ship and build clean.
  Base spans DO export to Langfuse. But the per-call tagging path is a **silent no-op** — see below.
  Two impl notes that hold: (a) import telemetry via the `telemetry` **namespace** on `@livekit/agents`
  (there is NO `./telemetry` subpath export).
- 🐞 **CORRECTION to a prior claim.** The earlier "v1/v2 cast is runtime-safe" note was WRONG. Reality:
  `@langfuse/otel` forces OTel SDK **v2**, but `@livekit/agents@1.2.0`'s `setTracerProvider(p, {metadata})`
  calls the **v1** `p.addSpanProcessor()`, which v2 removed → it **threw and crashed every flow on entry**
  (build `2026-05-31-thinkbudget0-callhardcap`). Another session correctly made all tracing calls
  non-fatal (try/catch; build `2026-05-31-tracing-nonfatal`) — **do not revert that.** Net today:
  the no-metadata `setTracerProvider(p)` (base spans) works; the `{metadata}` path throws + is swallowed,
  so `langfuse.session.id` / tags / metadata never attach → traces are **ungrouped + untagged.**
- ⛔ **OPEN — tagging fix (do NOT start until told; do NOT encode in any skill until verified live).**
  Options: a v2-native custom `SpanProcessor` added at construction reading a per-job ref (faithful port
  of LiveKit's `MetadataSpanProcessor`), or Candidate B (active root span). Verify tags land in a live
  Langfuse session BEFORE writing the mechanism into `samwise-livekit-agents`.
- ⏳ **Phase 0 Step 1 (USER)** — set `LANGFUSE_*` secrets on the deployed agent (`.env.local` already has
  them for local `pnpm dev`). Deploy is safe without (tracer no-ops).
- ⬜ Pending: fix tagging (above) → re-verify → propagate to `onboarding`/`call` · **Phase 2 judge — build
  it around the `langfuse` skill's `judge-calibration.md` (dataset experiment; `POST /api/public/scores`,
  not the cli)** · Phase 3 wire · Phase 4 cockpit · Phase 5 seams.
- 🔒 **Open concern — PII/masking.** We will ship full mental-health transcripts to Langfuse Cloud. Decide
  retention / masking / access before this runs on real prospects (the `langfuse` skill's baseline flags it).

## Plan Summary

Build the **hybrid observability layer** for Samwise: Langfuse as the trace spine (every conversation
becomes a session-grouped trace) + an online LLM **judge** that grades each finished conversation +
a custom **`/observability` cockpit** in samwise-app that reads Firestore and deep-links into Langfuse.

Designed so the next project (`EVALS AND LOAD TEST SUITE`) plugs in for free: synthetic load-test
sessions reuse the same tracing (tagged `synthetic`), the same judge, and the same `prompt_variant`
dimension.

**Context baked in (everything needed to implement without re-reading the context file):**

- **Conversations live in two agents.** `ritual-agent` serves 3 flows (`qualification`, `onboarding`,
  `call`) via a router `main.ts` keyed on dispatch `metadata.flow`; each flow is `src/flows/<flow>/index.ts`
  with a `runXFlow(ctx, meta)` entry. `tracking-agent` serves the tracking call. Both are
  `@livekit/agents@1.2.0`, LiveKit Cloud, secrets set via `lk agent update-secrets`.
- **LiveKit telemetry API (1.2.0, verified):** `import { setTracerProvider, tracer } from '@livekit/agents/telemetry'`.
  `setTracerProvider(provider: NodeTracerProvider, { metadata })` routes the framework's auto-emitted
  spans (per-turn LLM, STT, TTS, tool calls, with `gen_ai.*` + `lk.*` attributes) to our provider.
  `metadata` is "injected into all spans." There is also a global `tracer` (DynamicTracer) with
  `startActiveSpan`/`startSpan` for wrapping our own root span.
- **Langfuse is already wired in samwise-landing** (`instrumentation.ts`): `LangfuseSpanProcessor`
  from `@langfuse/otel` + `NodeTracerProvider` from `@opentelemetry/sdk-trace-node`, keys via
  `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL`. We reuse the SAME Langfuse project.
- **Langfuse OTel attribute keys (verified):** `langfuse.session.id`, `langfuse.trace.name`,
  `langfuse.trace.tags` (string[]), `langfuse.trace.metadata.<k>`. See `observability-contract.ts`.
- **The cloud-functions module** is one file `cloud-functions/functions/src/index.ts` (~2616 lines).
  LLM functions use `new GoogleGenerativeAI(requireEnv("GEMINI_KEY"))` →
  `getGenerativeModel({ model:"gemini-2.5-flash", generationConfig:{responseMimeType:"application/json"} })`
  → `model.generateContent(prompt)` → `result.response.text()` → `JSON.parse`. The judge mirrors
  `extractQualification` (index.ts:2130) exactly.
- **Worker→CF POST pattern (verified):** `ritual-agent/src/flows/qualification/index.ts` has
  `submitIfNotYet(reason)` that POSTs `{transcript, prospect_name, prospect_email, language}` to
  `EXTRACT_QUALIFICATION_URL` at end-of-call (endCall / disconnect / idle_timeout / hard_cap). The eval
  POST rides the same lifecycle. `buildTranscript(chatCtx)` already produces the `{role,content}[]` array.
- **Firestore funnel sources (verified collection names):** `qualifications` (has `outcome`,`qualified`,
  `prospectKey`,`createdAt`,`transcript`), `rituals`, `calendarBookings`, `trackingEvents` (KPI fields
  `relapse`/`ritualFulfilled`/`answeredCall`/`ritualUsedOut`), `demoCalls`, `users`. New collection
  this plan adds: `conversationEvals`.
- **The cockpit host:** `samwise-app` (Next.js App Router, Vercel) already has `lib/firebase-admin.ts`
  (lazy singleton), shadcn/ui, a sidebar shell. New route `app/observability/page.tsx`.

**Flag criteria for the judge (user-confirmed):** `off_script` (off-persona / leaked reasoning /
language switch / hallucination), `call_failure` (dropped / no-answer / too short / dead air / unintelligible),
`goal_not_met` (flow's own success condition missed). **Safety/distress is intentionally deferred** —
do NOT add it yet.

## Plan Architecture (Flow)

```
                         ┌─────────────────────── Langfuse Cloud (one project) ───────────────────────┐
   real prospect ──▶ ritual-agent / tracking-agent  ──(OTel spans: setTracerProvider)──▶  session trace │
   (or load-test    │  flow runs, framework auto-emits per-turn spans                     (grouped by    │
    agent, later)   │  + our root span carries langfuse.* attrs from ObsMeta              room name)     │
                    │                                                                                   │
                    └─ end-of-call ─▶ POST {transcript, obsMeta, outcome} ─▶ evaluateConversation (CF)  │
                                                                              │  Gemini judge            │
                                                                              ▼                          │
                                       Firestore: conversationEvals/{roomName} ◀── verdict {flagged,…}   │
                                                                              │                          │
   operator ──▶ samwise-app /observability  ──reads Firestore──▶ funnel + health + FLAGGED QUEUE         │
                                              row click ─────────────────────────────deep-link──────────┘
```

## Plan Structure (Directories and files)

```
NEW   samwise-backend/observability/observability-contract.ts        (DONE — canonical contract)
NEW   ritual-agent/src/config/observability.ts                       (mirror of contract)
EDIT  ritual-agent/src/main.ts                                       (Phase 1: provider init)
EDIT  ritual-agent/src/flows/qualification/index.ts                  (Phase 1: per-call attrs; Phase 3: eval POST)
EDIT  ritual-agent/src/flows/onboarding/index.ts                     (Phase 1 + 3)
EDIT  ritual-agent/src/flows/call/index.ts                           (Phase 1 + 3)
NEW   ritual-agent/src/services/eval.ts                              (Phase 3: postEval helper, shared by flows)
NEW   tracking-agent/src/config/observability.ts                     (mirror) + same main/flow edits (Phase 1 + 3)
EDIT  cloud-functions/functions/src/index.ts                         (Phase 2: + evaluateConversation, + EVAL_JUDGE_PROMPT)
NEW   samwise-app/lib/observability/firestore.ts                     (Phase 4: funnel + flagged-queue readers)
NEW   samwise-app/lib/observability/langfuse-link.ts                 (Phase 4: session deep-link builder)
NEW   samwise-app/app/observability/page.tsx                         (Phase 4: the cockpit)
NEW   samwise-app/app/observability/_components/*.tsx                 (Phase 4: cards)
EDIT  samwise-landing/app/api/qualify/chat/route.ts                  (Phase 5: add flow + synthetic tags)
```

---

## Modifications (in phases and steps)

> Implement **one phase at a time, in order**, verifying each before the next. Phase 1 is the spine —
> nothing downstream works until traces land. I will NOT write code until you approve this plan.

### Phase 0 / Step 1 — Langfuse keys onto the agents

- **In-file location:** none (env/secrets only).
- **Should not be modified:** the landing's Langfuse project — we reuse it.
- **Action:** Add the three vars to `ritual-agent` and `tracking-agent` LiveKit Cloud secrets (same
  values as samwise-landing's Vercel env):
  ```bash
  # run from each agent dir; values copied from samwise-landing Vercel env
  lk agent update-secrets \
    --secrets "LANGFUSE_PUBLIC_KEY=pk-lf-..." \
    --secrets "LANGFUSE_SECRET_KEY=sk-lf-..." \
    --secrets "LANGFUSE_BASE_URL=https://us.cloud.langfuse.com"
  ```
- **Explanation:** one shared Langfuse project = one pane of glass across landing + agents + functions.
  The instrumentation no-ops gracefully if a key is missing, so a partial deploy is safe.

### Phase 0 / Step 2 — Mirror the contract + install OTel deps in the agents

- **In-file location:** copy `observability/observability-contract.ts` → `ritual-agent/src/config/observability.ts`
  (and later the same into `tracking-agent/src/config/observability.ts`).
- **Code:** identical to the canonical file (already written).
- **Deps** (per agent): `@langfuse/otel` + `@opentelemetry/sdk-trace-node` are the same packages the
  landing uses. Install in `ritual-agent`:
  ```bash
  pnpm add @langfuse/otel @opentelemetry/sdk-trace-node
  ```
  (`@opentelemetry/api` is already present transitively via `@livekit/agents`; confirm with
  `pnpm why @opentelemetry/api`.)
- **Explanation:** gives the agent the Langfuse span processor + a Node tracer provider, exactly like
  the landing.

### Phase 1 / Step 1 — Initialize the Langfuse provider once per worker (`main.ts`)

- **In-file location:** `ritual-agent/src/main.ts`, at module top level (runs once when the worker
  process boots), after existing imports, before the worker/agent definition.
- **Should not be modified:** the existing router logic that picks a flow by `metadata.flow`.
- **Code:**
  ```ts
  import { LangfuseSpanProcessor } from '@langfuse/otel';
  import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
  import { setTracerProvider } from '@livekit/agents/telemetry';

  // One provider per worker process. The LiveKit Agents framework emits a span
  // tree per turn (LLM/STT/TTS/tool calls, gen_ai.* + lk.* attributes); routing
  // it through the Langfuse span processor makes every call a Langfuse trace.
  // Mirrors samwise-landing/instrumentation.ts. No-ops if LANGFUSE_* are unset.
  const langfuseSpanProcessor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [langfuseSpanProcessor],
  });
  setTracerProvider(tracerProvider);
  ```
- **Explanation:** This alone — with NO per-call attributes yet — already ships full per-turn traces to
  Langfuse, grouped by the framework's own job/room spans. Verify this lands before doing Step 2.

### Phase 1 / Step 2 — Attach per-call Langfuse attributes (the tagging)

> ⚠️ **This is the one mechanism I will not guess.** `setTracerProvider`'s `metadata` is "injected into
> all spans" (global). On a worker that runs concurrent jobs that would let one call's tags leak onto
> another's. LiveKit's own doc example puts per-job values (`room_id`, `job_id`) in that metadata,
> which implies they expect per-job calls. So Phase 1 Step 2 is a **bounded spike (~30 min)** with a
> recommended path and a documented fallback; the Phase-1 verification gate is the decider.

- **In-file location:** top of each `runXFlow(ctx, meta)` in `src/flows/*/index.ts` (for qualification:
  `index.ts:44`, right after `await ctx.connect()`).
- **Should not be modified:** the `AgentSession` construction, watchers, submission path.

- **Candidate A (recommended first — matches LiveKit's doc example, simplest):** re-point the provider
  per job with this call's attributes.
  ```ts
  import { setTracerProvider } from '@livekit/agents/telemetry';
  import { buildLangfuseAttributes } from '../../config/observability';
  // ...inside runQualificationFlow, after ctx.connect():
  setTracerProvider(tracerProviderSingleton, {
    metadata: buildLangfuseAttributes({
      flow: 'qualification',
      language: meta.language,
      sessionId: ctx.room.name,
      promptVariant: meta.prompt_variant,   // undefined → "default" (add to QualificationMeta in Phase 5)
      synthetic: meta.synthetic,            // undefined → false
      prospect_name ? prospectKey: ... ,    // optional
    }),
  });
  ```
  (Export the provider from `main.ts` as `tracerProviderSingleton` to reuse it.)
  **Decision criterion:** check the worker's concurrency. If workers effectively run one job per process
  (default for these WebRTC flows), the global metadata is safe and we keep A. If two calls can overlap
  on one worker, switch to B.

- **Candidate B (fallback — concurrency-safe):** keep `setTracerProvider(provider)` global (Step 1 only);
  wrap the call in our own active root span carrying the attributes, ended on shutdown.
  ```ts
  import { tracer } from '@livekit/agents/telemetry';
  import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';
  // create a manual root span (not auto-ended), make its context active for the session:
  const rootSpan = tracer.startSpan({
    name: 'qualification call',
    attributes: buildLangfuseAttributes({ /* same as above */ }),
    endOnExit: false,
  });
  const rootCtx = otelTrace.setSpan(otelContext.active(), rootSpan);
  await otelContext.with(rootCtx, async () => {
    await session.start({ agent, room: ctx.room, inputOptions: { /* ... */ } });
  });
  ctx.addShutdownCallback(async () => { rootSpan.end(); });
  ```
  Risk to verify: that framework spans created *after* `session.start` resolves (on later event-loop
  turns) still nest under `rootSpan`. If they don't, prefer A under low concurrency.

- **Explanation:** Either way the trace ends up with `langfuse.session.id = room name`, the four tags,
  and the metadata keys. The verification gate (below) confirms which behaves correctly in Langfuse.

### Phase 2 / Step 1 — The judge cloud function `evaluateConversation`

- **In-file location:** `cloud-functions/functions/src/index.ts`, appended near `extractTrackingKpis`
  (after index.ts:2322's block). Add `EVAL_JUDGE_PROMPT` constant alongside the other prompt constants.
- **Should not be modified:** `extractQualification`, `extractTrackingKpis`, `requireEnv`, the shared
  `GoogleGenerativeAI` import (index.ts:439), `setGlobalOptions`.
- **Code (mirrors extractQualification exactly):**
  ```ts
  const EVAL_JUDGE_PROMPT = `You are a QA judge for Samwise conversation agents.
  You are given the FLOW, the call OUTCOME (if known), and the TRANSCRIPT.
  Grade ONLY these three failure dimensions. Be conservative: flag only on clear evidence.

  - off_script: the agent broke persona, leaked internal reasoning, switched language away from {LANG},
    hallucinated facts about Samwise, or violated the one-question-per-turn rule egregiously.
  - call_failure: the call dropped early, the user could not be understood, long dead air, or it ended
    with no meaningful exchange (e.g. < 2 user turns of substance).
  - goal_not_met: the flow's own success condition was missed. qualification → no clear qualify/disqualify
    reached; onboarding → the six topics not meaningfully covered; call → the ritual phases not walked;
    tracking → the KPIs (relapse/ritual/answered) not actually elicited.

  Return STRICT JSON: {
    "flagged": boolean,                       // true if ANY dimension failed
    "dimensions": { "off_script": boolean, "call_failure": boolean, "goal_not_met": boolean },
    "severity": "low" | "medium" | "high",
    "reasons": string[],                      // one short reason per failed dimension, quoting evidence
    "summary": string                         // one sentence for the triage queue
  }

  FLOW: {FLOW}
  OUTCOME: {OUTCOME}
  TRANSCRIPT:
  {TRANSCRIPT}`;

  export const evaluateConversation = onRequest(
    {cors: true, timeoutSeconds: 120},
    async (req, res) => {
      interface TranscriptTurn { role: "user" | "assistant"; content: string; }
      interface EvalBody {
        transcript: TranscriptTurn[];
        flow: "qualification" | "onboarding" | "call" | "tracking";
        language: "es" | "en";
        sessionId: string;               // LiveKit room name — the correlation key
        outcome?: string;                // e.g. "qualified" | "disqualified" | "abandoned"
        promptVariant?: string;
        synthetic?: boolean;
        prospectKey?: string;
      }
      interface Verdict {
        flagged: boolean;
        dimensions: { off_script: boolean; call_failure: boolean; goal_not_met: boolean };
        severity: "low" | "medium" | "high";
        reasons: string[];
        summary: string;
      }
      try {
        if (req.method !== "POST") { res.status(405).json({error: "Method Not Allowed"}); return; }
        const body = req.body as EvalBody;
        if (!body.flow || !body.sessionId) { res.status(400).json({error: "flow and sessionId required"}); return; }
        if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
          res.status(400).json({error: "transcript required (non-empty array)"}); return;
        }

        const rendered = body.transcript.map((t) => `${t.role}: ${t.content}`).join("\n\n");
        const filledPrompt = EVAL_JUDGE_PROMPT
          .replace("{LANG}", body.language)
          .replace("{FLOW}", body.flow)
          .replace("{OUTCOME}", body.outcome ?? "unknown")
          .replace("{TRANSCRIPT}", () => rendered);

        const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
        const model = gemini.getGenerativeModel({
          model: "gemini-2.5-flash",
          generationConfig: {responseMimeType: "application/json"},
        });

        let verdict: Verdict;
        try {
          const result = await model.generateContent(filledPrompt);
          verdict = JSON.parse(result.response.text()) as Verdict;
        } catch (err) {
          logger.error("evaluateConversation: Gemini parse failed", err);
          res.status(502).json({error: "judge LLM failed"}); return;
        }

        const db = getFirestore();
        // Doc id = sessionId (room name) so re-grades overwrite, never duplicate.
        await db.collection("conversationEvals").doc(body.sessionId).set({
          ...verdict,
          flow: body.flow,
          language: body.language,
          sessionId: body.sessionId,
          outcome: body.outcome ?? "unknown",
          promptVariant: body.promptVariant ?? "default",
          synthetic: body.synthetic ?? false,
          prospectKey: body.prospectKey ?? "",
          transcriptTurns: body.transcript.length,
          createdAt: FieldValue.serverTimestamp(),
        });

        res.status(200).json({ok: true, flagged: verdict.flagged, sessionId: body.sessionId});
      } catch (err) {
        logger.error("evaluateConversation failed", err);
        res.status(500).json({error: err instanceof Error ? err.message : String(err)});
      }
    }
  );
  ```
- **Explanation:** transcript + flow + outcome in → conservative three-dimension verdict out → one
  `conversationEvals/{roomName}` doc (the cockpit's flagged-queue source). Doc-id = room name = idempotent
  re-grade. No email, no other side effects.
- **Deploy:** `firebase deploy --only functions:evaluateConversation`; note its run URL for Phase 3.
- **(Deferred sub-step, needs confirmation) Langfuse score push:** also POST the verdict as a Langfuse
  *score* on the session so it shows inside the trace UI. Requires confirming the Langfuse public scores
  API (endpoint/body/whether it attaches by sessionId or traceId) — verify at
  https://api.reference.langfuse.com before wiring. Firestore is the source of truth regardless; this is
  cosmetic. Do NOT block Phase 2 on it.

### Phase 3 / Step 1 — Shared `postEval` helper in the agents

- **In-file location:** new `ritual-agent/src/services/eval.ts` (mirror into tracking-agent later).
- **Code:**
  ```ts
  const EVALUATE_CONVERSATION_URL = process.env.EVALUATE_CONVERSATION_URL;

  export interface PostEvalArgs {
    transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
    flow: 'qualification' | 'onboarding' | 'call' | 'tracking';
    language: 'es' | 'en';
    sessionId: string;          // ctx.room.name
    outcome?: string;
    promptVariant?: string;
    synthetic?: boolean;
    prospectKey?: string;
  }

  // Fire-and-forget. The eval must NEVER delay or break the user-facing close.
  export async function postEval(args: PostEvalArgs): Promise<void> {
    if (!EVALUATE_CONVERSATION_URL) {
      console.warn('[eval] EVALUATE_CONVERSATION_URL not set — skipping');
      return;
    }
    if (args.transcript.length === 0) return;
    try {
      const resp = await fetch(EVALUATE_CONVERSATION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!resp.ok) console.error('[eval] non-OK', { status: resp.status, sessionId: args.sessionId });
    } catch (err) {
      console.error('[eval] post failed', err);   // swallow — never affects the call
    }
  }
  ```
- **Deps:** add `EVALUATE_CONVERSATION_URL` to each agent's LiveKit secrets (the Phase-2 run URL).

### Phase 3 / Step 2 — Call `postEval` at end-of-call in each flow

- **In-file location:** `qualification/index.ts` inside `submitIfNotYet`, after the extraction response is
  parsed (`outcome` is set ~index.ts:377) — fire `postEval` without awaiting:
  ```ts
  // after `outcome = data.outcome;`
  void postEval({
    transcript,
    flow: 'qualification',
    language: meta.language,
    sessionId: ctx.room.name,
    outcome,
    promptVariant: meta.prompt_variant,
    synthetic: meta.synthetic,
    prospectKey: data.prospectKey,
  });
  ```
  For `onboarding` and `call`: there is no extraction step, so call `postEval` from the existing
  shutdown / end-of-call hook with `buildTranscript(agent.chatCtx)` and the flow's own `outcome` notion
  (e.g. onboarding: did the doc get filled; call: ritual completed). Mirror `buildTranscript`
  (qualification/index.ts:298) into a shared util if not already shared.
- **Should not be modified:** the existing extraction POST, the `submitted` idempotency guard, the
  data-event publishes.
- **Explanation:** the judge runs within minutes of the call ending; `void`/fire-and-forget guarantees it
  never delays the user's `FinalScreen` swap.

### Phase 4 / Step 1 — Firestore readers in samwise-app

- **In-file location:** new `samwise-app/lib/observability/firestore.ts`.
- **Should not be modified:** `lib/firebase-admin.ts` (reuse its `getDb()`/admin singleton).
- **Code (sketch — fill query bounds during impl):**
  ```ts
  import { getFirestore } from '@/lib/firebase-admin'; // adjust to the existing export name

  export interface FlaggedEval {
    sessionId: string; flow: string; severity: string; summary: string;
    reasons: string[]; createdAt: number; promptVariant: string;
  }

  // Flagged-call triage queue (prod only; newest first).
  export async function getFlaggedEvals(limit = 50): Promise<FlaggedEval[]> {
    const db = getFirestore();
    const snap = await db.collection('conversationEvals')
      .where('synthetic', '==', false)
      .where('flagged', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(limit).get();
    return snap.docs.map((d) => /* map to FlaggedEval */ ({ ...(d.data() as any), sessionId: d.id }));
  }

  // Funnel counts over a window (today / 7d). One helper per collection:
  //   qualifications: total, qualified, disqualified
  //   rituals: total registered
  //   calendarBookings: total booked
  //   trackingEvents: relapses, ritualFulfilled, answeredCall, ritualUsedOut
  // Use createdAt >= windowStart filters. Returns a single FunnelSnapshot object.
  export async function getFunnelSnapshot(sinceMs: number): Promise<FunnelSnapshot> { /* ... */ }
  ```
- **Index note:** the `conversationEvals` query needs a composite index on
  `(synthetic ==, flagged ==, createdAt desc)` — Firestore will print the create-index link on first run.

### Phase 4 / Step 2 — The cockpit page + cards

- **In-file location:** new `samwise-app/app/observability/page.tsx` (Server Component — reads Firestore
  via firebase-admin, like `/meet`/`/book` server routes) + `_components/` cards.
- **Should not be modified:** the sidebar shell / `app/layout.tsx` (just add an `/observability` nav link).
- **Shape:**
  - `<FunnelCard>` — today + 7d: qualifications (qualified/disqualified), rituals, bookings, tracking KPIs.
  - `<HealthCard>` — call failures from `conversationEvals` where `dimensions.call_failure == true`; short/no-answer counts.
  - `<FlaggedQueue>` — table of `getFlaggedEvals()`: severity chip, flow, summary, reasons, **deep-link** to Langfuse.
- **Auth:** matches samwise-app v1 — no auth (internal). Note for later: gate behind Clerk before exposing.

### Phase 4 / Step 3 — Langfuse deep-link

- **In-file location:** new `samwise-app/lib/observability/langfuse-link.ts`.
  ```ts
  // UI base differs from API base; project id from the Langfuse dashboard URL.
  const UI_BASE = process.env.NEXT_PUBLIC_LANGFUSE_UI_BASE ?? 'https://us.cloud.langfuse.com';
  const PROJECT_ID = process.env.NEXT_PUBLIC_LANGFUSE_PROJECT_ID ?? '';
  export function langfuseSessionUrl(sessionId: string): string {
    return `${UI_BASE}/project/${PROJECT_ID}/sessions/${encodeURIComponent(sessionId)}`;
  }
  ```
- **Needs confirmation:** the exact session-URL shape + the project id — grab both from the Langfuse UI
  once a real session lands (Phase 1 verification). Adjust the template if it differs.

### Phase 5 / Step 1 — Forward seams for the load-test suite

- **In-file location:** `ritual-agent/src/types/metadata.ts` — add optional `prompt_variant?: string` and
  `synthetic?: boolean` to each flow's metadata variant (defaulting handled by `buildLangfuseAttributes`).
- **In-file location:** `samwise-landing/app/api/qualify/chat/route.ts` — add `flow: 'qualification'`,
  `synthetic` (from a request flag), and `prompt_variant` to the existing `experimental_telemetry.metadata`
  so the text-mode chat carries the same tags.
- **Explanation:** no load-test agent is built here (that's the next project) — we only ensure the
  `synthetic` + `prompt_variant` dimensions exist end-to-end and the cockpit filters `synthetic`. Verifies
  the seam by sending one manual `synthetic:true` dispatch and confirming it appears in Langfuse tagged
  `synthetic` and is absent from the funnel.

---

### Testing phase

- **Local test (Phase 1):** run `ritual-agent` with `pnpm dev`, take one real `/qualify` call from the
  landing dev server. Within ~10s confirm in Langfuse: (a) a session appears, (b) it contains per-turn
  spans with `gen_ai.*` attributes, (c) `langfuse.session.id` == the room name, (d) the four tags +
  metadata keys are present (Step 2 decider between Candidate A/B). Verify with the curl from
  `reference_langfuse_nextjs_setup.md`.
- **Local test (Phase 2):** `curl` the deployed `evaluateConversation` with a hand-made transcript for
  each flow; confirm a `conversationEvals/{sessionId}` doc with a sane verdict; re-POST the same sessionId
  → confirm overwrite (no dup).
- **Integration test (Phase 3):** take a full `/qualify` call; confirm the call closes normally AND a
  `conversationEvals` doc appears keyed by that room name, with the same outcome the user saw.
- **Integration test (Phase 4):** open `/observability`; confirm funnel counts match Firestore, the
  flagged queue lists the test call, and the deep-link opens the right Langfuse session.
- **Concurrency check (Phase 1 Step 2):** if Candidate A — start two overlapping calls; confirm their
  tags don't cross-contaminate in Langfuse. If they do, switch to Candidate B.
- **Update README:** add an `## Observability` section to each agent's README (how traces flow, the env
  vars) and a short `cloud-functions` note for `evaluateConversation`.

### After implementation

- Update `observability/context-for-code-agent.md` → "Recent Changes" with what shipped per phase.
- Create/update the touched modules' working files: `cloud-functions` currently has NONE — add a minimal
  `context-for-code-agent.md` documenting `evaluateConversation`; update `ritual-agent` +
  `tracking-agent` context/style files with the tracing wiring; update `samwise-app` context with the
  `/observability` route.
- Mark `OBSERVABILITY` DONE in the master Vibe doc Projects tab (manual user step).
