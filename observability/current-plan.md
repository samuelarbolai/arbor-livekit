# current-plan.md — Observability (FRESH START, 2026-06-04)

> Prior attempt was reverted (tracing code removed; `observability/` HQ docs + `.env.local` keys kept).
> This plan redoes it correctly, grounded in the `langfuse` skill (docs-first) and the
> `samwise-livekit-agents` "Langfuse tracing" lessons. Architecture is unchanged from the approved
> design; what changed: (1) the **tagging mechanism** is fixed, (2) scope expands to **5 flows**.

## Status

- ⬜ Nothing implemented yet (clean slate). All code below is unbuilt.
- 🔑 `.env.local` still holds `LANGFUSE_*`; Langfuse project `samwise-landing-qualify` (org `samwise`) is live and verified (landing's text traces land there).
- 📚 Use the `langfuse` skill for every Langfuse docs/API question (never from memory). The judge (Phase 2) follows its `references/judge-calibration.md`; flagged-call triage follows `references/error-analysis.md`.

## Plan Summary

Hybrid observability for Samwise: **Langfuse = trace spine** (every conversation a session-grouped, tagged trace) + an **online LLM judge** that flags conversations needing intervention + a custom **`/observability` cockpit** in samwise-app. Built so the next project (load-test suite) reuses the same tracing (tagged `synthetic`), judge, and `prompt_variant` dimension.

**Context baked in (no need to re-read the context file):**

- **Conversations now span 5 flows** in `ritual-agent` (`main.ts` routes by `metadata.flow`): `call` (SIP ritual), `onboarding` (WebRTC), `qualification` (WebRTC), `demo-call` (WebRTC autonomous sales — see `samwise-demo-call-agent` skill), `scribe` (note-taker). Plus `tracking-agent` (SIP). Each conversational flow is `src/flows/<flow>/index.ts` with a `runXFlow(ctx, meta)` entry; tracing attaches with one helper call after `ctx.connect()`.
- **LiveKit telemetry (1.2.0):** the framework auto-emits a span tree per turn (`agent_session.ts` creates `sessionSpan`/`agentSpeakingSpan`/`userSpeakingSpan` via its `tracer`; spans carry `gen_ai.*` model+token attrs). Import the telemetry API via the **`telemetry` namespace** on `@livekit/agents` (NO `./telemetry` subpath export). Register our provider with `telemetry.setTracerProvider(provider)` — **no metadata arg** (that path calls v1 `addSpanProcessor`, removed in v2 → crashes the worker; see `samwise-livekit-agents`). Always wrap tracing in try/catch — observability must never kill a call.
- **Langfuse OTel attribute keys (doc-verified 2026-06-04):** `langfuse.session.id`, `langfuse.trace.tags` (string[]), `langfuse.trace.name`, `langfuse.trace.metadata.<k>`. Docs: attrs must be on **every span**, not just the root, to filter/aggregate.
- **`@langfuse/otel` requires OTel SDK v2** (`@opentelemetry/sdk-trace-node@2.x`). Same packages/shape as `samwise-landing/instrumentation.ts`.
- **cloud-functions** = one file `functions/src/index.ts`. The judge `evaluateConversation` mirrors `extractQualification`/`extractDemoCall` exactly (`onRequest({cors:true,timeoutSeconds:120})`, `GoogleGenerativeAI(requireEnv("GEMINI_KEY"))`, `responseMimeType:"application/json"`, Firestore write).
- **Firestore funnel sources:** `qualifications`, `rituals`, `calendarBookings`, `trackingEvents` (`relapse`/`ritualFulfilled`/`answeredCall`/`ritualUsedOut`), `demoCalls`. New collection: `conversationEvals`.
- **Cockpit host:** `samwise-app` (`/observability` route; has `lib/firebase-admin.ts`).
- **Flags (approved):** `off_script` / `call_failure` / `goal_not_met`. Safety/distress deferred.

## Plan Architecture (Flow)

```
real call (or synthetic load-test) ─▶ ritual-agent / tracking-agent
   │  LangfuseMetadataSpanProcessor stamps langfuse.* attrs on EVERY span (onStart),
   │  reading the per-job attrs set by applyConversationTracing() at flow start.
   ▼
Langfuse Cloud (session = room name, tagged flow/lang/synthetic/variant)
   │
   └─ end-of-call ─▶ POST {transcript, obsMeta, outcome} ─▶ evaluateConversation (CF, Gemini judge)
                                                              └─▶ conversationEvals/{roomName} (verdict)
operator ─▶ samwise-app /observability ─reads Firestore─▶ funnel + health + FLAGGED QUEUE
                                          row → deep-link → Langfuse session
```

## Plan Structure (files)

```
NEW  observability/observability-contract.ts          (exists; re-verify keys vs docs)
NEW  observability/langfuse-span-processor.ts          (NEW canonical: the stamping SpanProcessor)
NEW  ritual-agent/src/config/observability.ts          (mirror of contract + span processor)
NEW  ritual-agent/src/config/tracing.ts                (lazy provider, non-fatal, custom processor)
EDIT ritual-agent/src/main.ts                          (initTracing() in prewarm)
EDIT ritual-agent/src/flows/{qualification,onboarding,call,demo-call}/index.ts  (one helper call)
NEW  ritual-agent/src/services/eval.ts                 (postEval helper)
EDIT cloud-functions/functions/src/index.ts            (+ evaluateConversation + EVAL_JUDGE_PROMPT)
NEW  samwise-app/lib/observability/*.ts + app/observability/page.tsx  (cockpit)
```

## Modifications (phases & steps)

> Implement one phase at a time; verify each before the next. Plan handed back for approval before any code.

### Phase 0 — Foundations
- Re-add deps to `ritual-agent`: `pnpm add @langfuse/otel@^5 @opentelemetry/sdk-trace-node@^2 @opentelemetry/api@^1.9`.
- Mirror `observability-contract.ts` + the new `langfuse-span-processor.ts` into `ritual-agent/src/config/observability.ts`.
- `lk agent update-secrets` the three `LANGFUSE_*` on the deployed agent (the step that was never done last time → the reason zero traces landed).

### Phase 1 — Trace spine (THE corrected core)

**Step 1 — the stamping SpanProcessor** (`observability/langfuse-span-processor.ts`, mirrored):
```ts
import type { Span } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-node';

// Per-worker mutable "current call" attrs, set at flow start. Stamped on EVERY span
// at onStart (Langfuse docs: attrs must be on each span, not just the root).
let currentAttrs: Record<string, string | string[]> = {};
export function setConversationAttrs(a: Record<string, string | string[]>) { currentAttrs = a; }
export function clearConversationAttrs() { currentAttrs = {}; }

export class LangfuseMetadataSpanProcessor implements SpanProcessor {
  onStart(span: Span): void { try { span.setAttributes(currentAttrs); } catch { /* never throw */ } }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
```

**Step 2 — `tracing.ts`** (lazy, non-fatal; provider gets BOTH processors at construction):
```ts
import { telemetry } from '@livekit/agents';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseMetadataSpanProcessor, setConversationAttrs } from './observability';
import { buildLangfuseAttributes, type ObsMeta } from './observability';

let provider: NodeTracerProvider | null = null;
function ensureProvider(): NodeTracerProvider {
  if (provider) return provider;
  const { LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk, LANGFUSE_BASE_URL: url } = process.env;
  const processors = pk && sk && url
    ? [new LangfuseMetadataSpanProcessor(), new LangfuseSpanProcessor({ publicKey: pk, secretKey: sk, baseUrl: url })]
    : [];
  provider = new NodeTracerProvider({ spanProcessors: processors });
  try { telemetry.setTracerProvider(provider as never); }   // NO metadata arg — v2-safe
  catch (err) { console.warn('[tracing] non-fatal', err); }
  return provider;
}
export function initTracing(): void { try { ensureProvider(); } catch (e) { console.warn('[tracing]', e); } }
export function applyConversationTracing(meta: ObsMeta): void {
  try { ensureProvider(); setConversationAttrs(buildLangfuseAttributes(meta)); } catch (e) { console.warn('[tracing]', e); }
}
```

**Step 3 — wire:** `initTracing()` in `main.ts` prewarm; `applyConversationTracing({ flow, language: meta.language, sessionId: ctx.room.name ?? ctx.job.id })` after `ctx.connect()` in each of the 4 conversational flows (`scribe` only if it runs its own LLM).

**Step 4 — VERIFY LIVE (the gate we never passed):** take a `/qualify` call on a worker that has the keys (stop the deployed keyless worker first, or test deployed after update-secrets). Confirm in Langfuse: a session grouped by **room name**, with `flow:`/`lang:`/`prod`/`variant:default` tags + metadata on the spans. **Concurrency check:** two overlapping calls don't cross-contaminate; if they do → switch to the OTel **Baggage + BaggageSpanProcessor** mechanism (doc-recommended, per-context safe) instead of the global `currentAttrs`.

### Phase 2 — The judge (`evaluateConversation`)
Mirror `extractQualification`. Input `{transcript, flow, language, sessionId, outcome?, promptVariant?, synthetic?, prospectKey?}` → Gemini judges `off_script`/`call_failure`/`goal_not_met` (per-flow rubric) → write `conversationEvals/{sessionId}`. **Build + validate it per the `langfuse` skill's `judge-calibration.md`** (dataset experiment; scores via `POST /api/public/scores`). Covers all 5 flows.

### Phase 3 — Wire flows → judge
`services/eval.ts` `postEval()` (fire-and-forget, never blocks the close), called at end-of-call in each flow alongside existing submit hooks.

### Phase 4 — Cockpit `/observability` in samwise-app
Server component reading Firestore: funnel (qual/rituals/bookings/tracking/demo) + health (call_failure flags) + flagged-call triage queue (`conversationEvals`, `synthetic==false`), each row deep-linking to its Langfuse session.

### Phase 5 — Load-test seam
Add `prompt_variant?` + `synthetic?` to the flow metadata types; landing's qualify chat carries the same tags. Cockpit filters `synthetic`.

### Testing
- Phase 1 local: `pnpm dev` (keys in `.env.local`) + `/qualify` call → tags land (Step 4 gate). Cross-check with `langfuse-cli` / the traces API.
- Phase 2: `curl` the judge per flow → `conversationEvals` doc; re-POST same sessionId → overwrite.
- Phase 4: counts match Firestore; deep-link opens the right session.

### After implementation
Update `observability/context-for-code-agent.md` Recent Changes; update `samwise-livekit-agents` "Langfuse tracing" with the **verified** tagging mechanism (only once Step 4 passes); mark task DONE in the master Vibe doc.

### PII note (open)
Full mental-health transcripts will land in Langfuse Cloud — decide retention/masking/access before real-prospect use (langfuse skill baseline flags it).
