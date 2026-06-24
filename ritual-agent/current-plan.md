# current-plan.md — Ritual-call agent prompt: rename four beats, add Enemy as third characteristic

> **Overwrites the previous plan** ("Demo Call: grado-driven desidentificación skip (agent slice)" — SHIPPED).
> **Status: PROPOSAL ONLY. No file edits yet.** This document is the user-approved scope of the next backend round. Implementation does NOT begin until the user gives an explicit "go."
> **Coordinated change.** This plan ships in lockstep with `samwise-backend/cloud-functions/functions/src/current-plan.md`. Read both. They MUST land in the same deploy session — order is enforced in the "Deploy sequence" section of the cloud-functions plan.
> **Strict minimal-changes mandate from the user.** Nothing in `src/flows/call/agent.ts` moves except what is explicitly listed below. If a line is not named in this file, it stays byte-for-byte identical.

## Plan Summary

Three textual edits to the system-prompt string literal inside `samwise-backend/ritual-agent/src/flows/call/agent.ts`. **No TypeScript changes. No new tools. No new files. No deployment infrastructure changes.**

- **C1 — Rename the four beats inside `<goal>`** and re-anchor each on the matching renamed XML tag (renamed in lockstep with cloud-functions S1). Beat shape per step (label + description + elicit-fallback sentence) is preserved verbatim; only labels and tag references move.
- **C2 — Add a third "Named adversary" characteristic** inside `<context of all this>`, plus two small line edits to keep the surrounding paragraph consistent with the rename.
- **C3 — Explicit no-op of everything else.** `<personality>`, `<environment>`, `<tone and style>`, the elicit-fallback inside each beat, the `<examples>` block, the `stripStageDirections` TTS guard, and the file's TypeScript structure — all untouched.

The TTS pipeline, LiveKit infrastructure, dispatch metadata, and the agent's voice/persona are not affected.

## Plan Architecture (Flow)

1. Cron `checkUsersRituals` fires at a scheduled slot — **unchanged.**
2. `makeCallsBatchFunction` dispatches `ritual-agent` with the flow's metadata — **unchanged.** Dispatch metadata shape stays as today (`flow: 'call'`, `user_id`, `language`, `voice_id`, `core_motivation`, `user_inputs`, `symbolic_help`, `social_help`, etc.).
3. The agent's `flows/call/index.ts` builds the `chatCtx` from dispatch metadata + the synthesized `userInputs` blob — **unchanged.**
4. `new Agent(chatCtx)` is constructed in `flows/call/agent.ts`. The `instructions` string passed to the base class is the system prompt. **This is the ONLY file modified.**
5. The agent's system prompt now references the renamed tags (`<EXIT FROM THE DAY>` instead of `<THE STOP>`, etc.) and contains the new "Named adversary" characteristic. The synthesized userInputs (produced under cloud-functions S1+S2+S3) carries the matching renamed tags + the new `<enemy>` tag — **so the agent finds them and runs the four beats as today, just with new labels.**
6. TTS goes through the existing `stripStageDirections` pipeline — **unchanged.**

## Plan Structure (Directories and files)

```
samwise-backend/ritual-agent/
├── current-plan.md                # THIS FILE
└── src/
    └── flows/
        └── call/
            ├── agent.ts            # MODIFIED — C1 + C2 only (string-literal edits inside the instructions template)
            ├── idleWatchdog.ts     # NOT MODIFIED
            ├── index.ts            # NOT MODIFIED
            ├── shutdownPolicy.ts   # NOT MODIFIED
            ├── sipDispatch.ts      # NOT MODIFIED
            └── thinkingFiller.ts   # NOT MODIFIED
```

No new files. No deletions. No imports added or removed. No TypeScript signature changes.

## Modifications (in phases and steps)

> **What changes inside `src/flows/call/agent.ts` — line by line.**
>
> The only mutated region is the `` ` `` template literal passed to `super({ instructions: ... })` in the `Agent` constructor. Lines numbered against the file as it stood at proposal time.

### Phase 1 / Step 1 — C1: rename the four beats inside `<goal>`

- **In-file location:** the `<goal>` block currently at lines ~74–91 of `agent.ts`. Inside, the four numbered beats (`1. Stop: …`, `2. Consciousness and Faith: …`, `3. Intention: …`, `4. Commitment: …`).
- **Modification:** rename each beat's label AND re-anchor each on the matching renamed tag. The beat's body description and trailing elicit-fallback sentence stay verbatim per beat.

  | Old beat line | New beat line |
  |---|---|
  | `1. Stop: Help the user treat themselves well. Help them reassure their own capabilities. Help the user enjoy the little things. Anchor all this on their own input of <THE STOP> tag content. Interact with the user and ask for the input if the tag has no content.` | `1. Exit from the day: Help the user treat themselves well. Help them reassure their own capabilities. Help the user enjoy the little things. Anchor all this on their own input of <EXIT FROM THE DAY> tag content. Interact with the user and ask for the input if the tag has no content.` |
  | `2. Consciousness and Faith: Help the user remember why is he/she stopping to make this session. Help the user remember the benefits to obtain, including the smallest and most immediate ones. Help the user remember what is he/she trying to nurture and protect. Anchor all this on their own input of <THE CONSCIOUSNESS> tag content. Interact with the user and ask for the input if the tag has no content.` | `2. Entry into the work: Help the user remember why is he/she stopping to make this session. Help the user remember the benefits to obtain, including the smallest and most immediate ones. Help the user remember what is he/she trying to nurture and protect. Anchor all this on their own input of <ENTRY INTO THE WORK> tag content. Interact with the user and ask for the input if the tag has no content.` |
  | `3. Intention: Help the user allow himself/herself to be ambitious. Help the user express their desires to accomplish right now, in the most immediate minutes, in the mid-term, and in the long-term. Anchor all this on their own input of <THE INTENTION> tag content. Interact with the user and ask for the input if the tag has no content.` | `3. Intentions, three horizons: Help the user allow himself/herself to be ambitious. Help the user express their desires to accomplish right now, in the most immediate minutes, in the mid-term, and in the long-term. Anchor all this on their own input of <INTENTIONS> tag content. Interact with the user and ask for the input if the tag has no content.` |
  | `4. Commitment: Help the user make a little covenant for his immediate ritual and for the rest of the day. Anchor all this on their own input of <THE COMMITMENT> tag content. Interact with the user and ask for the input if the tag has no content.` | `4. The pact: Help the user make a little covenant for his immediate ritual and for the rest of the day. Anchor all this on their own input of <THE PACT> tag content. Interact with the user and ask for the input if the tag has no content.` |

- **Should NOT be modified:**
  - The leading `-> Prepare the user for the session:` block (lines ~78–83) — verbatim.
  - The `-> Start the session:` header — verbatim.
  - The four beats' descriptions in between the label and `Anchor all this on…` — verbatim per row above (left vs right side of the table differ only in label + tag name).
  - The elicit-fallback sentence at the tail of each beat — verbatim. (The user clarified this stays as a safety net.)
- **Explanation:** the four-beat skeleton is preserved exactly. The synthesized userInputs (after cloud-functions S1) carries the matching renamed tags. Together, the agent finds and reads the content under each renamed tag without any other change.

### Phase 1 / Step 2 — C2: add Enemy as a third characteristic in `<context of all this>`

- **In-file location:** the `<context of all this>` block currently at lines ~95–101.
- **Modifications (three small edits inside the block):**

  1. **Update the parts list.**
     - **Before:** `Those parts are: the stop, the consciousness, the intention, the commitment.`
     - **After:** `Those parts are: exit from the day, entry into the work, intentions, the pact.`

  2. **Update the characteristics count.**
     - **Before:** `On top of the steps, two characteristics apply to the entire session. One is required, and the other is optional to apply at the user's discretion whenever possible. These characteristics are the following:`
     - **After:** `On top of the steps, three characteristics apply to the entire session. One is required, and the other two are optional to apply at the user's discretion whenever possible. These characteristics are the following:`

  3. **Add a new third bullet** at the end of the existing Symbolic help / Social help pair, indented to match the prior two bullets:

     ```
     -> Named adversary: Many users have given their core problem a proper-noun Enemy. When <enemy> is set, use that name consistently throughout the session as if the listener already knows who it is. Never re-explain or paraphrase it.
     ```

- **Should NOT be modified:**
  - The opening sentence of `<context of all this>` — *"The whole point of this sessions is to help the user become more autonomous in his own quest for setting themselves free of a consumption problem of some sort or a very important habit that is being difficult for them to adopt."* — verbatim.
  - The next sentence — *"You are merely helping them remember certain things they have already set for themselves."* — verbatim.
  - The Symbolic help bullet — verbatim.
  - The Social help bullet — verbatim.

### Phase 1 / Step 3 — C3: explicit no-op of everything else

These regions of `agent.ts` are NOT modified in this round. Any edit to any of them is a scope violation:

- The file-top imports (`llm, voice` from `@livekit/agents`; `TransformStream, type ReadableStream` from `node:stream/web`) — verbatim.
- The `STAGE_DIRECTION` regex and `stripStageDirections` function — verbatim.
- The `Agent` class declaration line — verbatim.
- The `constructor(chatCtx: llm.ChatContext)` signature and `super({ chatCtx, instructions: ... })` call — structural; verbatim.
- The `<personality>` block — verbatim.
- The `<environment>` block — verbatim.
- The `<tone and style>` block — verbatim.
- The `<examples>` block (currently empty) — verbatim. Do NOT seed a worked example in this round.
- The `ttsNode` override at the bottom — verbatim.

## Testing phase

### Local test (TDD per `samwise-livekit-agents` skill)

The skill is explicit: any agent behavior change requires test-driven changes. Even though C1+C2 are string edits, they alter runtime behavior.

1. From `samwise-backend/ritual-agent/`, run `pnpm test` to confirm the existing test suite still passes (no test should reference the old beat labels — if any do, the test is the problem, fix it inline as part of this phase).
2. **New test (minimum scope):** add to `src/flows/call/agent.test.ts` (or create the file if it does not exist) a test that:
   - Instantiates the agent with a mock `chatCtx` containing a synthesized userInputs blob whose four renamed tags (`<EXIT FROM THE DAY>` etc.) are populated and whose `<enemy>` tag is filled with a proper noun.
   - Walks one or two turns of dialogue and asserts the agent's reply references each renamed beat in turn AND uses the Enemy's proper noun without re-explaining it.
   - Per the `samwise-livekit-agents` skill: use `new google.LLM({ model: AGENT_MODEL })` directly (NOT inference.LLM) and follow the canonical test shape under `flows/qualification/*.test.ts` or `flows/call/*.test.ts` if one exists.
3. Run `pnpm format` and `pnpm lint` to confirm style/lint pass.

### Integration test (after deploy)

- Bump `BUILD_TAG` in `main.ts` (the `samwise-livekit-agents` skill mandates this on every deploy). Suggested suffix: `-rename-beats-add-enemy`.
- After `lk agent deploy`, trigger a smoke call (self-dispatch via `lk dispatch create --new-room --agent-name ritual-agent --metadata '{"flow":"call",...}'` — fill in metadata fields per the dispatch contract) against a staging user whose Doc has already been re-registered through cloud-functions S1+S2+S3.
- Confirm via `lk agent logs --id <CA_…>` that `[ritual-agent] build=<NEW_TAG>` appears.
- Confirm the agent's spoken output uses the new beat labels (e.g. "Now, exit from the day" rather than "Now, the stop") and references the Enemy's proper noun if the test user's Doc carries one.

### Update README

`samwise-backend/ritual-agent/README.md` — **DO NOT update in this phase.** It's the upstream LiveKit template README; documentation drift acknowledged, out of scope.

---

## Deploy sequence (load-bearing — see cloud-functions plan)

The full deploy sequence is documented in `samwise-backend/cloud-functions/functions/src/current-plan.md` under "Deploy sequence." Summary as it concerns this repo:

1. `cloud-functions` is deployed FIRST. The agent must not boot before its tag contract matches.
2. THEN `ritual-agent` is deployed.
3. Both deploys happen in the same operator session.

If you deploy `ritual-agent` before `cloud-functions`, every active ritual call that fires in the gap will see old-named tags (`<THE STOP>` etc.) and the renamed agent prompt will fall into its elicit-fallback for every beat — the call will technically run but the user will be interrogated live for content they already wrote in their Doc.

---

## After implementation

### Update `samwise-backend/ritual-agent/context-for-code-agent.md`

Append a Recent Changes entry dated the implementation date:
- The ritual-call agent's four beats were renamed: Stop → Exit from the day; Consciousness and Faith → Entry into the work; Intention → Intentions, three horizons; Commitment → The pact. Tag references in the prompt were updated in lockstep with cloud-functions S1.
- A third characteristic "Named adversary" was added to `<context of all this>` to handle the new `<enemy>` tag from cloud-functions S3.
- TDD test coverage added under `src/flows/call/agent.test.ts`.

### Update `samwise-livekit-agents` skill

In `/Users/samuelgiraldoconcha/Documents/samwise/.claude/skills/samwise-livekit-agents/SKILL.md`:
- No structural change to the skill is needed — the beat rename is a string-level coordination between two prompt files, not an infrastructure pattern. The "router pattern" section, the Dockerfile sections, the build/deploy sections — all unchanged.
- Optionally, in the section describing `flows/call/`'s tag contract (if such a section exists; otherwise skip), update the tag names to match.

### Mark task DONE

The user manually marks the corresponding task in the master Vibe doc Projects tab.

---

## Strict out-of-scope list (do NOT touch this round)

If you find yourself editing any of the below in this round, STOP — that change does not belong here:

- **`flows/call/index.ts`** — not touched. Dispatch metadata reading, `chatCtx` construction, session lifecycle, shutdown wiring — all verbatim.
- **`flows/call/idleWatchdog.ts`** — not touched. The 8-second check-in timing, the gate logic, the spoken filler — all verbatim.
- **`flows/call/shutdownPolicy.ts`** — not touched. `userTurnCount`, the `setFallbackActive` shutdown callback — verbatim.
- **`flows/call/sipDispatch.ts`** — not touched. Telnyx trunk, `createSipParticipant`, all SIP wiring — verbatim.
- **`flows/call/thinkingFiller.ts`** — not touched. The "Mmm." / "Hmm." filler — verbatim.
- **`src/config/providers.ts`** — not touched. `gemini-2.5-flash`, `thinkingBudget: 0`, `includeThoughts: false`, the FallbackAdapter, `safetySettings` — all verbatim.
- **`src/main.ts`** — only the `BUILD_TAG` constant is bumped (per skill mandate, not as a "change"). No other modification.
- **Other flows** — `flows/onboarding/`, `flows/qualification/`, `flows/qualification-therapist/`, `flows/demo-call/`, `flows/scribe/` — NONE are touched. The Symbolic anchor / Exit from the day / etc. vocabulary lives in the `onboarding` flow's `<topics_to_cover>` block already, by coincidence — that block is the REFERENCE for the renamed beats but is NOT modified in this round.
- **`Dockerfile`, `pnpm-workspace.yaml`, `patches/`** — not touched.
- **`.env.local`, `livekit.toml`, `package.json`, `tsconfig.json`** — not touched.
- **The `<examples>` block in `agent.ts`** — stays empty. No worked example seeded this round.
- **Voice provider stack** — Deepgram / Google Gemini / Cartesia / Silero / LiveKit MultilingualModel / `BackgroundVoiceCancellation()` — all verbatim.
- **`stripStageDirections` regex and TransformStream** — verbatim. No change to the TTS guard.

---

## Open questions (for the user, BEFORE implementation)

These are the only unresolved scope questions. I list them so you can answer them at "go" time rather than deferring them mid-implementation.

1. **Re-registration policy.** When cloud-functions ships S1, all pre-existing `rituals/{id}` documents in Firestore still carry the OLD tag names inside their stored `userInputs` blob. Either (a) re-POST each active ritual's Doc URL through `registerNewRitual` to regenerate, OR (b) accept that the first call after the agent deploys will hit elicit-fallback and the user will be live-prompted for content they already wrote. Decide before implementation.
2. **Worked-example Enemy line in synthesis prompt.** Either fill Thomas's example output with `<enemy>la enfermedad</enemy>` (mirrors his existing "my disease" metaphor) OR leave it as `<enemy></enemy>` (empty). Decide before implementation.
3. **Whether to also update `samwise-backend/cloud-functions/functions/src/google-doc-template.md`** (the canonical-Doc-template reference). My recommendation: NO this round — it's a doc-only file that's out of sync with the actual Doc template already. Reconcile in a follow-up.
