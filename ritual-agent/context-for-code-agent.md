# context-for-code-agent.md — ritual-agent

## Parent Project Overview

The parent project (`samwise`) is Samwise: a system that helps users overcome behavioural challenges (screens addiction, social media, destructive relationships, etc.) by combining mental-health practitioners, spiritual guidance, and AI agents that follow up via scheduled "ritual" calls. The platform is composed of multiple services: cloud functions for ritual registration/update + qualification, LiveKit voice agents, a chat agent, a streaming agent, the user-facing application (`samwise-app`), and the public landing page (`samwise-landing`).

## Parent Project Architecture (Flow)

1. Prospects discover Samwise through the public landing (`samwise-landing`).
2. They go through the Fit Assessment Call (the qualification flow) at `/qualify` — voice (primary) or text (currently disabled in UI). Run by `ritual-agent`'s `flows/qualification/` worker.
3. The qualification result is written to Firestore (`qualifications/` collection) and a confirmation email is sent to the prospect via the Firebase Trigger Email extension.
4. Qualified prospects book a Breakthrough Call via the Cal link surfaced on FinalScreen.
5. After the Breakthrough Call, the rep / clinician runs a Call Design Session — an onboarding voice flow served by `ritual-agent`'s `flows/onboarding/` worker — that fills the user's personal ritual document.
6. The completed ritual doc is registered via `cloud-functions`'s `registerNewRitual` (parses the doc via Gemini, writes a structured `RitualData` to Firestore).
7. A scheduler cron (`checkUsersRituals` in `cloud-functions`) every 30 min builds a `DAY_HH:MM` schedule key and dispatches the `ritual-agent`'s `flows/call/` (SIP outbound) to the user at the scheduled times.
8. The ritual call is conducted; the agent updates Firestore with progress markers.
9. Progress is tracked by `tracking-workflow` (Vercel) + `tracking-agent` (LiveKit).

## Parent Project Modules

- `samwise-backend/cloud-functions/` — Firebase Cloud Functions (ritual registration/update, dispatcher cron, Session Copilot, qualification extractor).
- `samwise-backend/ritual-agent/` — **this module**, the multi-flow LiveKit voice worker (qualification, onboarding, call).
- `samwise-backend/narya-agent/` — production morning-coaching LiveKit agent.
- `samwise-backend/tracking-agent/` — production tracking-call LiveKit agent.
- `samwise-backend/tracking-workflow/` — Vercel-hosted orchestration for the tracking loop.
- `samwise-app/` — internal/user-facing application (separate from the public landing).
- `samwise-landing/` — public landing page + `/qualify`.
- `MCPs/`, `samuel-2026/` — tooling and sandbox.

## Module Overview — ritual-agent

LiveKit Agents (Node.js) worker that serves **three conversation flows** behind one `agentName: "ritual-agent"`. The worker's `main.ts` is a thin router that picks a flow function based on dispatch metadata (`flow: "call" | "onboarding" | "qualification"`):

- **`flows/call/`** — SIP outbound phone-ritual flow. Triggered by the `cloud-functions` scheduler cron via `makeCallsBatchFunction`.
- **`flows/onboarding/`** — WebRTC Call Design Session (Dra. Ana María persona). Triggered by `samwise-app`.
- **`flows/qualification/`** — WebRTC Fit Assessment Call (Nova persona). Triggered by `samwise-landing/app/qualify/`. Uses the **agent / scribe split**: the agent (`QualificationAgent`) converses + takes live notes via `setVariables`; the `extractQualification` cloud function turns the post-call transcript into the authoritative structured payload.

One Dockerfile, one deploy, one set of secrets — adding a new flow does not multiply DevOps surface. See `samwise-livekit-agents` skill (or `programming-style.md`) for the router pattern and per-flow conventions.

## Module Structure (Directories and files)

```
samwise-backend/ritual-agent/
├── src/
│   ├── main.ts                          # Worker entry; routes dispatches to flows by metadata.flow
│   ├── config/
│   │   ├── providers.ts                 # makeStt/makeLlm/makeTts factories — Deepgram, Gemini 2.5 Flash, Cartesia
│   │   └── voiceIds.ts                  # Per-language voiceID maps for each flow
│   ├── services/
│   │   ├── drive.ts                     # Google Drive/Docs API client (lazy singleton; FIREBASE_SERVICE_ACCOUNT auth)
│   │   └── firestore.ts                 # Firebase Admin handle
│   ├── types/
│   │   └── metadata.ts                  # Discriminated union for dispatch metadata
│   └── flows/
│       ├── call/                        # SIP phone-ritual flow
│       │   ├── index.ts                 # runCallFlow — connect, SIP participant, AgentSession
│       │   ├── agent.ts                 # CallAgent — ritual reading + progress tools
│       │   ├── sipDispatch.ts           # Telnyx trunk + waitForParticipant
│       │   └── prompts/
│       ├── onboarding/                  # WebRTC Call Design Session
│       │   ├── index.ts                 # runOnboardingFlow + attaches idle handler
│       │   ├── agent.ts                 # OnboardingAgent — 6 topics + readGoogleDoc tool
│       │   ├── idleHandler.ts           # CANONICAL idle-shutdown pattern, reused by qualification
│       │   └── prompts/
│       └── qualification/               # WebRTC Fit Assessment Call
│           ├── index.ts                 # runQualificationFlow — single-agent + agent/scribe split
│           ├── agent.ts                 # QualificationAgent — setVariables + endCall tools
│           ├── schema.ts                # MIRROR of samwise-landing/lib/qualify/schema.ts
│           └── prompts/
│               ├── persona.ts           # NOVA characterization (bilingual)
│               └── qualification-prompt.ts  # MIRROR of samwise-landing/lib/qualify/qualification-prompt.ts
├── Dockerfile                            # Patched per samwise-livekit-agents skill (HF cache copy + ENV redirects)
├── livekit.toml                          # Deploy config (LiveKit Cloud)
├── package.json
├── tsconfig.json
├── AGENTS.md                             # LiveKit-provided starter doc (points at this file)
├── CLAUDE.md                             # → AGENTS.md
├── context-for-code-agent.md             # This file
├── current-plan.md                       # Active plan tracking
└── programming-style.md                  # LiveKit-agent specific patterns (REQUIRED per vibe procedure)
```

## Conventions specific to this module

### Router pattern: one worker, many flows

A new conversation lives as a new `flows/<name>/` folder, **never** as a parallel `*-agent/` sibling module. The user has corrected this once already — see `samwise-livekit-agents` skill and memory `feedback_livekit_agent_routes.md`. Shared infrastructure (env getter, provider factories, voiceID lookup, Firestore + Drive services) lives in `src/config/` and `src/services/`.

### Sources of truth for cross-repo files

- **`flows/qualification/schema.ts`** is a MIRROR of `samwise-landing/lib/qualify/schema.ts`. When you change one, change both.
- **`flows/qualification/prompts/qualification-prompt.ts`** is a MIRROR of `samwise-landing/lib/qualify/qualification-prompt.ts`. The landing-side is the canonical source per vibe procedure (the worker copies). When you change one, change both. Worker's `./persona` and landing's `./persona` are also kept in sync.

### Provider stack — direct plugins, not LiveKit Inference

| Concern | Plugin | Model |
|---|---|---|
| STT | `@livekit/agents-plugin-deepgram` | `nova-3` |
| LLM | `@livekit/agents-plugin-google` | `gemini-2.5-flash` (do NOT bump to gemini-3-flash-preview; see programming-style.md) |
| TTS | `@livekit/agents-plugin-cartesia` | `sonic-3` |
| VAD | `@livekit/agents-plugin-silero` | (loaded once in `prewarm`) |
| Turn detection | `@livekit/agents-plugin-livekit` | `MultilingualModel` |

`config/providers.ts` is the only place these are constructed. Each flow imports `makeStt`/`makeLlm`/`makeTts` and never touches the plugin packages directly.

### Required env vars / LiveKit Cloud secrets

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `DEEPGRAM_API_KEY`, `GOOGLE_API_KEY`, `CARTESIA_API_KEY`
- `SIP_OUTBOUND_TRUNK_ID` — must be `ST_ZP2XarSMKEHh` (Telnyx). NOT `ST_ADp6qTAT3bXK` (Twilio — blocked for Colombia).
- `FIREBASE_SERVICE_ACCOUNT` — JSON-string, for Firestore + Drive API.
- `EXTRACT_QUALIFICATION_URL` — URL of `cloud-functions`'s `extractQualification` HTTP endpoint. Used by `flows/qualification/index.ts`'s `submitIfNotYet`.

Set via `lk agent update-secrets --secrets-file <file> --overwrite`.

### Voice UX patterns (canonical, do not re-derive)

These all live in `programming-style.md` with examples — included here as a checklist for any new flow:

- Override `onEnter` with `this.session.generateReply()` if the agent should speak first.
- Verbal filler timer on `AgentStateChanged → thinking` with `addToChatCtx: false`.
- ONE question per turn in `<hard-rules>`.
- For WebRTC flows: idle handler via `flows/onboarding/idleHandler.ts`'s `attachIdleShutdown` (10 min default).
- For WebRTC flows: `preemptiveGeneration` OFF (mic conditions unpredictable; cancelled TTS leaks fragments).
- Audio-quality block in the system prompt; mic-test fallback after one round of "could you repeat?"

### Recent Changes

- **2026-05-25 — Qualification flow redesign (converse → extract):** Single-agent + agent/scribe split. Replaced two-agent intake→capture handoff with one `QualificationAgent`. Agent's job is conversation + live notes via `setVariables` tool (publishes `qualification:variable_update` data events to the room → fills `<VariablesPanel>` on the landing). At end-of-call (`endCall` tool OR `participantDisconnected` OR `idle_timeout`), worker POSTs full transcript to `extractQualification` cloud function which produces the authoritative `QualificationPayload` and dispatches the post-call confirmation email. Replaced `gateDecision`+`submitQualification` tools with `setVariables`+`endCall`; replaced `intake-prompt.ts`+`capture-prompt.ts` with one `qualification-prompt.ts` (mode param: `voice` | `text`). Disconnect-flush via `participantDisconnected` listener guarded by closure-scoped `submitted` flag.
