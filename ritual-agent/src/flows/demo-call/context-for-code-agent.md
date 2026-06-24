# context-for-code-agent.md — ritual-agent / flows/demo-call

> Working files for the **Demo Call Agent** — a new conversation flow inside the
> `ritual-agent` LiveKit worker. `programming-style.md` is NOT duplicated here:
> the LiveKit-agent patterns at `samwise-backend/ritual-agent/programming-style.md`
> apply verbatim. The fuller ritual-agent module description lives at
> `samwise-backend/ritual-agent/context-for-code-agent.md`; this file only adds
> what is specific to the demo-call flow.

## Parent Project Overview

Samwise: a behaviour-change program. Funnel: Prospecting → **Fit Assessment Call**
(`/qualify`, the qualification flow) → **Demo Call** (70 min, this flow) →
Onboarding (150 min, Dra. Ana María) → daily AI ritual calls → optimization
sessions. The Demo Call's mission is to help the prospect *decide whether to help
themselves* — NOT a traditional close (coercing a no→yes produces 30-day refunds).
Two valid outcomes: a commitment + deposit, OR a clean re-classification into the
disqualified-rebound flow where the prospect becomes a high-quality referrer.

## Parent Project Architecture (Flow)

1. Prospect qualifies at `/qualify` (ritual-agent `flows/qualification/`). Result →
   Firestore `qualifications/{prospectKey}` (prospectKey is email-derived).
2. Qualified prospect books the Demo Call.
3. **Demo Call (this flow):** an autonomous voice agent runs the 70-min script with
   the prospect over WebRTC. The prospect hears the agent and watches live story
   visuals on screen; there is **no human rep** in the room.
4. Captured variables persist to Firestore `demoCalls/`; qualified closers proceed
   to Onboarding.

## Parent Project Modules

- `samwise-backend/ritual-agent/` — **this module's parent**, the multi-flow LiveKit
  worker (`call` / `onboarding` / `qualification` / **`demo-call`** ← new).
- `samwise-backend/cloud-functions/` — `loadCallScript`, `cleanVariable`,
  `suggestRepLine`, `appendDemoCallRow`, `loadQualification`, `extractQualification`.
- `samwise-app/` — the human rep `/copilot` (the Demo Call's variable + story-visual
  contract is defined here; the agent reuses it).
- `samwise-landing/` — the public `/qualify` AND the prospect-facing `/meet` receiver
  (`app/meet/call-room.tsx` → renders `RitualStory`; subscribes to the DataChannel).

## Module Overview — flows/demo-call

An **autonomous** LiveKit voice agent (no human rep) that runs the Demo Call script
end-to-end and drives the prospect's screen. Decisions locked with the user
(2026-06-01):

- **Autonomous, solo.** No supervisor/takeover console. The `/copilot` surface is
  the *human* rep's tool and is not used live during an agent-run call.
- **Voice + live story visuals.** Audio-only agent (LiveKit agents are audio-only).
  The prospect watches the existing `RitualStory` visuals evolve; no avatar/video.
- **Script lives in the Google Doc (never baked, never cached).** The worker loads
  the Demo script Doc at call start and the phase machine + spoken lines come from
  it — same Doc the human `/copilot` reads (Doc id
  `1sBHuGaXCFaP8cmQdUgNpoQYwCq3L4-OfDMDoPR73a5g`). Editing the Doc changes the next
  call's behaviour with no redeploy. The persona/rules/few-shots are baked into the
  agent prompt; the *words* are not.
- **Tools are write-only side-effects. The agent never calls a tool to READ.**
  Everything the agent reads is pre-loaded into its prompt context by the worker
  (the "human has the next part of the script in front of them" model) — a mid-call
  read-tool would add a tool round-trip + a second LLM turn of latency.
- **Dynamic prompt block, sliding window.** The worker maintains a dynamic block
  carrying the current phase + the next 1-2 phases, with `{{variables}}` already
  substituted from captured state. Advanced by a write-only `enterPhase` signal.

### What the agent reuses (already built — do NOT rebuild)

- **DataChannel contract** (`samwise-app/lib/demo-call/broadcast.ts`): the agent
  publishes the same reliable JSON the human rep does —
  `{ type: "demo-call:variable_update", name, value }` (per `userVisible` variable)
  and `{ type: "demo-call:show_visual", stage }` (`stage ∈ hidden|doc|promise|loop|
  mechanism|experience`). The prospect's `/meet` receiver already decodes by `type`,
  not by sender → **zero frontend changes** to receive agent-published messages.
- **Variable contract** (`samwise-app/app/copilot/demo-call-config.ts`,
  `DEMO_CALL_VARIABLES`): the canonical variable list, `userVisible` set (the 7 the
  prospect watches), `frameworkSemantics`, `fit_state` (`qualified|still_disqualified`,
  drives `[CONDITION]` phase visibility), the `behaviour_to_change` (short clause) vs
  `behaviour_example` (full incident) split. The agent's variable set mirrors this.
- **Script parse** (`loadCallScript` CF): parses the Doc's `[SAY]`/note/`[CONDITION]`
  markers into structured phases/blocks. The worker calls it (uncached) — single
  parser shared with `/copilot`, no drift.
- **Qualification prefill** (`loadQualification` CF, by email/prospectKey): the
  prospect's Fit Assessment data. Phase 1.5 reflects it; the agent never re-asks it.

### Persona & guardrails (from before-the-call doc + skills)

- Persona = the **Carolina-Borrero centered-clinician** ("expensive lady, old money,
  never desperate"), with the **`evaluar` admission-test register**: *the agent is
  evaluating the prospect, not vice-versa.* Three scarcity beats (Phase 1 frame →
  Phase 8.5 evaluation pause → Phase 11 verdict "vi lo que necesitaba ver") — run all
  three or none.
- **Spoken-output vocabulary blacklist** (samwise-script-work Rule 7): never speak
  `paciente`, `comportamiento autodestructivo`, `recaída`, `terapia`, `clínico`,
  `diagnóstico`. The agent may reason in clinical terms internally; it never speaks
  them.
- Negotiation beats are Voss techniques (negotiation skill): Phase 1.5 = "That's
  Right" (`¿Es así?`); money = mirror + 4s silence → calibrated `¿Qué?/¿Cómo?`
  (never `¿Por qué?`) → Borrero dignity-exit; Phase 10 = accusation audit.
- Four-beat listening (Reflect→Track→Align→Guide); frame→concrete-action, never
  frame→motivational-slogan; ONE question per turn.

## Module Structure (Directories and files)

> Target layout once the plan is implemented (see `current-plan.md`). Mirrors
> `flows/qualification/` (the closest analog — web voice flow, live capture).

```
src/flows/demo-call/
├── index.ts                 # runDemoCallFlow — providers, session, lifecycle, prefill, submit
├── agent.ts                 # DemoCallAgent — setVariables/showVisual/enterPhase/endCall + onEnter
├── script.ts                # load Doc via loadCallScript; segment phases (incl. 5b steps); filter by [CONDITION]/fit_state
├── dynamicBlock.ts          # build the current-phase + lookahead block with {{var}} substitution
├── broadcast.ts             # publish demo-call:variable_update / demo-call:show_visual (port of samwise-app/lib/demo-call/broadcast.ts)
├── variables.ts             # the demo-call variable set + userVisible flags (mirror of demo-call-config.ts)
├── prompts/
│   ├── persona.ts           # Borrero centered-clinician characterization
│   └── demo-call-prompt.ts  # baked persona/rules/phase-index/few-shots/audio-quality; the dynamic block is appended at runtime
├── context-for-code-agent.md  # this file
└── current-plan.md            # the active build plan
```

Shared, unchanged: `src/config/providers.ts` (`makeStt`, `makeQualificationLlm` +
`UNFILTERED_SAFETY_SETTINGS`, `makeTts`), `src/services/drive.ts`,
`src/flows/onboarding/idleHandler.ts` (reused), `src/flows/qualification/stallRecovery.ts`
(reused), `src/types/metadata.ts` (extended), `src/main.ts` (one case added).

## Conventions specific to this module

- **Live capture is for UX + branching + substitution; the authoritative record is
  produced downstream (converse→extract).** The agent captures variables live via
  `setVariables` because they (a) fill the prospect's screen, (b) drive the `fit_state`
  branch at Phase 8.5, (c) get substituted into later spoken blocks. At end-of-call the
  worker POSTs the transcript to **`extractDemoCall`** — the single unified
  demo-persistence CF (the human `/copilot` Save button migrates onto it too) — for the
  authoritative `demoCalls` record. The agent captures values **already in script-fit
  form** (it generates the language anyway) — so there is **no live `cleanVariable`
  round-trip** (latency).
- **`fit_state` is the branch.** Captured at Phase 8.5 via `setVariables`. The worker
  filters Doc phases by their `[CONDITION: fit_state=…]` exactly as `/copilot`'s
  script-pane does — phases 9-15 (close) when `qualified`, 16-17 (rebound) when
  `still_disqualified`; phases 1-8 always show.
- **Web-flow lifecycle is mandatory** (samwise-livekit-agents): `preemptiveGeneration:
  false`, `attachIdleShutdown` (10 min) + an independent **80-min wall-clock hard cap**
  (the call runs ~70 min — NOT qualification's 25)
  → `ctx.shutdown`, `attachStallRecovery`, verbal filler on `thinking`, the
  `<audio-quality>` block + bad-mic handling. Mirror `flows/qualification/index.ts`.
- **Gemini config inherited**: `gemini-2.5-flash` + `thinkingBudget:0` via
  `makeQualificationLlm` (the FallbackAdapter to OpenAI — clinical content + a 70-min
  call needs the empty-completion net). `UNFILTERED_SAFETY_SETTINGS` (BLOCK_NONE) as
  for qualification. Tool args use `.nullish()`, never `.optional()`.
- **Voice reuses the qualify table** (decided 2026-06-01): import
  `QUALIFICATION_VOICE_ID_BY_LANGUAGE` from `config/voiceIds.ts` (es =
  `13ff5deb-2591-42ad-a356-63a04e524411`). Brand-fixed by language, NOT per-user.
- **New flow = new `flows/<name>/`, never a sibling `*-agent/` module.**
