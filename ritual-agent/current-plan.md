# current-plan.md — Qualification flow redesign (converse → extract)

## Status: SHIPPED 2026-05-25

This plan describes the most recent task on `ritual-agent`. All phases are complete and deployed to LiveKit Cloud production. Pair plan: `samwise-landing/current-plan.md` (landing-side slice) and `samwise-backend/cloud-functions/functions/src/current-plan.md` (cloud-function slice, if updated).

## Plan Summary

Replace the qualification flow's two-agent **intake → capture handoff** with a single agent + agent/scribe split. The agent has one job: converse with the prospect and take live notes via a `setVariables` tool. At end-of-call, a separate extraction LLM (in the `extractQualification` cloud function) reads the full transcript and produces the authoritative `QualificationPayload`. The submission path is single-write: whichever of `endCall` / `participantDisconnected` / `idle_timeout` fires first wins.

Why: the prior handoff introduced a seam where the Capture agent treated itself as a fresh start and re-asked the prospect for things Intake had already established. The user surfaced this on a real call. Handoffs in LiveKit are designed for **routing** (triage → specialist where the specialist could plausibly start cold), not **phasing** the same conversation with the same persona.

## Plan Architecture (Flow)

```
USER ──voice──► Worker (QualificationAgent, single prompt, no phases)
                  │
                  │ During call: agent calls setVariables({...}) as facts emerge.
                  │   tool.execute publishes qualification:variable_update on
                  │   room data channel ──► frontend <VariablesPanel> fills live.
                  │
                  │ End of call (endCall tool OR participantDisconnected OR
                  │ idle_timeout) routes through submitIfNotYet() — guarded
                  │ by a closure-scoped `submitted` flag.
                  ▼
              Worker POSTs transcript to extractQualification cloud function
                  │
                  ▼
         extractQualification CF
              ├─ Gemini 2.5 Flash extraction pass (temp 0, transcript in)
              ├─ Compute qualified/disqualified from extracted gate values
              ├─ Write qualifications/{prospectKey}-{ts} doc to Firestore
              └─ Write mail/ doc → Firebase Trigger Email extension → email
```

## Plan Structure (Directories and files)

```
samwise-backend/ritual-agent/src/flows/qualification/
├── index.ts                                # CHANGED: added submitIfNotYet, ParticipantDisconnected
│                                           #          listener, attachIdleShutdown, EXTRACT_URL env var
├── agent.ts                                # REWRITTEN: setVariables + endCall tools (was: gateDecision +
│                                           #            submitQualification handoff path)
├── schema.ts                               # REWRITTEN: SetVariablesArgsSchema, EndCallArgsSchema,
│                                           #            self-contained QualificationPayloadSchema
└── prompts/
    ├── persona.ts                          # UNCHANGED
    ├── qualification-prompt.ts             # NEW: single prompt, mode: 'voice' | 'text'
    ├── intake-prompt.ts                    # REMOVED
    └── capture-prompt.ts                   # REMOVED
```

## Modifications (in phases and steps)

### Phase A — Backend pipeline

#### A1 — Rewrite the prompt
- **File**: `flows/qualification/prompts/qualification-prompt.ts` (new)
- One continuous conversation. No phase vocabulary. Two tools (`setVariables`, `endCall`). `mode: 'voice' | 'text'` parameter swaps the audio-quality block for a chat-mode block. EN + ES.
- The prompt's role: have a thoughtful interview + commit verbatim notes. The extraction LLM at end-of-call infers the gate verdicts; the agent never produces them.

#### A2 — Refactor `QualificationAgent`
- **File**: `flows/qualification/agent.ts`
- Drop `gateDecision` + `submitQualification` tools. Add:
  - `setVariables(args)` — Zod schema with 7 optional string fields. Publishes one `qualification:variable_update` data event per committed variable.
  - `endCall()` — invokes `callbacks.onEndCall()` passed in via constructor. Guarded by closure `endCalled` flag.
- `onEnter` override preserved (Nova speaks first).

#### A3 — Wire single submission path
- **File**: `flows/qualification/index.ts`
- Add `submitIfNotYet(reason)` function in the flow's scope. Idempotent on `submitted` boolean.
- Three trigger paths converge: `onEndCall` callback (passed to `QualificationAgent`), `RoomEvent.ParticipantDisconnected` listener (ignoring local participant), `attachIdleShutdown(ctx, session)` (10 min — reuses canonical onboarding helper).
- Submission body: full transcript built from `agent.chatCtx.items` (text messages only, role user/assistant), POSTed to `EXTRACT_QUALIFICATION_URL`. On success, publish `qualification:outcome` data event so frontend swaps to `<FinalScreen>`. Skipped on disconnect path (frontend already gone).
- Submission failure leaves `submitted = true` (no retry mid-shutdown; cloud function is the system-of-record).

#### A4 — Create `extractQualification` cloud function
- **File**: `samwise-backend/cloud-functions/functions/src/index.ts`
- See `cloud-functions/functions/src/current-plan.md` for the cloud-function-side slice.

#### A5 — Firebase Trigger Email extension + Gmail SMTP
- Out-of-code config step. Install via Firebase console with `mail/` collection, Gmail App Password for `samuelgiraldoconcha@gmail.com`, region `us-east1` (must match Firestore region).

### Phase B — Frontend UI

See `samwise-landing/current-plan.md`.

### Phase C — Polish

#### C1 — Email visual polish
- Done in `cloud-functions`: table-based HTML mirroring `<VariablesPanel>` register (small-caps Manrope-fallback label + Fraunces-fallback italic verbatim quote, gold ✦ on the Samwise wordmark).

#### C2 — End-to-end smoke + idempotency tests
- Validated in production: happy-path qualified, DQ, mid-call disconnect, idle timeout, variable overwrite, double-trigger idempotency.

## Idempotency (Three Layers)

1. **Worker-side `submitted` flag** (closure-scoped in `index.ts`) — prevents within-call duplicates from competing triggers.
2. **Cloud function writes timestamped docs** (`qualifications/{prospectKey}-{ts}`) — duplicates land as separate docs, never overwriting.
3. **`loadQualification` returns latest** (`orderBy createdAt DESC LIMIT 1`) — `/copilot` always sees the most recent; duplicates are wasted storage, never wrong data.

## Testing phase

- Local test: `pnpm dev` in `ritual-agent`, with `EXTRACT_QUALIFICATION_URL` set to the deployed CF URL. Voice call from local samwise-landing.
- Integration test: production qualify call from `samwise.life/qualify`. Run all six smoke cases from C2.
- Update README: not required for this redesign (README is the LiveKit starter doc).

## After implementation

- Update `context-for-code-agent.md` Recent Changes section: ✓ done.
- Mark task DONE in master Vibe doc Projects tab (manual user step).
