# current-plan.md — Synthesis prompt: rename core tags, multi-slot Ritual, add `<enemy>`, Docs API + tab isolation

> **Overwrites the previous plan** ("Replace loadCallScript's Gemini call with a deterministic parser" — SHIPPED).
> **Status: IMPLEMENTED (S1+S2+S3+S4). Awaiting deploy.** S4 (Docs API + tab isolation) was added mid-round per the user's request after they saw the example-tab leak risk and the multi-tab structure of the Nashla Doc.
> **Coordinated change.** This plan ships in lockstep with `samwise-backend/ritual-agent/current-plan.md`. The agent-prompt slice MUST land in the same deploy session — order is enforced in the "Deploy sequence" section below.
> **Strict minimal-changes mandate from the user.** Nothing in `ritual_synthesis_prompt.txt` or `index.ts` moves except what is explicitly listed below. If a line is not named in this file, it stays byte-for-byte identical.

## Plan Summary

Three additions to `samwise-backend/cloud-functions/functions/src/ritual_synthesis_prompt.txt` to align the synthesized `userInputs` blob with (a) the new Doc framework's vocabulary, (b) multi-slot daily rituals, and (c) the named adversary the new Doc structurally treats as a proper noun:

- **S1 — Rename four top-level tags.** `<THE STOP>` → `<EXIT FROM THE DAY>`. `<THE CONSCIOUSNESS>` → `<ENTRY INTO THE WORK>`. `<THE INTENTION>` → `<INTENTIONS>`. `<THE COMMITMENT>` → `<THE PACT>`. **Content per tag is unchanged; sub-tags inside each block are unchanged.**
- **S2 — Extend Rule 7's `<Ritual>` semantics** to require multi-slot rituals to be emitted as plain-prose, time-keyed sub-blocks (one per slot, opened with time + activity name). Single-slot rituals stay free-form, as today.
- **S3 — Add a new top-level `<enemy>` tag** (sibling to `<user-details>`) that stores the proper-noun name the user gives their adversary. Empty when no Enemy is named in the raw material.
- **S4 — Switch `registerNewRitual` from plain-text export to Docs API + tab isolation.** Read `Behavioural picture` + `Ritual` + `Ritual Call` tabs as synthesis raw material. Read `Metadata` tab for the five required keys. Fall back to whole-Doc with a BIG warning when any tabs are missing (legacy untabbed Docs continue to work; the warning surfaces the leak risk in cloud-functions logs).

S1+S2+S3 flow into the prompt file itself: the rules block (Rule 7), the worked example output. S4 is a small refactor inside `registerNewRitual` in `index.ts` plus one new helper (`extractTabsAsText`) sited next to `flattenDocToText`. No schema changes to the `schedules` / `fallbackSchedules` arrays. No new cloud functions. No new dependencies (googleapis Docs API already in use by `loadCallScript` and `createRitualDoc`).

## Plan Architecture (Flow)

1. The frontend POSTs `{ googleDocLink }` to `registerNewRitual` — **unchanged.**
2. `registerNewRitual` parses Metadata, fetches Doc title, builds the enriched raw material — **unchanged.**
3. `registerNewRitual` loads `SYNTHESIS_PROMPT` from `ritual_synthesis_prompt.txt` — **unchanged** (`fs.readFileSync` + build-time `cp` are intact).
4. Gemini runs the synthesis prompt → returns the JSON envelope `{ userInputs, schedules, fallbackSchedules, behaviorLabel, userID }`. **The shape of this envelope is unchanged.** What changes is the *content* of the `userInputs` string:
   - It now contains `<EXIT FROM THE DAY>`, `<ENTRY INTO THE WORK>`, `<INTENTIONS>`, `<THE PACT>` (instead of `<THE STOP>` etc.) — **S1.**
   - Its `<Ritual>` sub-tag, when the Doc has multiple daily slots, is emitted as labeled prose sub-blocks — **S2.**
   - It now contains a top-level `<enemy>` tag — **S3.**
5. `RitualData` is built, written to Firestore at `rituals/{id}`. **The Firestore document shape is unchanged** — `userInputs` is still a single opaque string carried inside `agentConfig.userInputs`. The downstream call agent reads it as today; the rename + multi-slot structure are absorbed in the agent's prompt (see the ritual-agent plan).

## Plan Structure (Directories and files)

```
samwise-backend/cloud-functions/functions/src/
├── ritual_synthesis_prompt.txt    # MODIFIED — S1, S2, S3 (see below)
├── index.ts                       # MODIFIED — S4 only (Docs API + tab isolation in registerNewRitual + new extractTabsAsText helper)
├── current-plan.md                # THIS FILE
└── google-doc-template.md         # NOT MODIFIED (documentation drift acknowledged; out of scope)
└── extraction_*.txt               # NOT MODIFIED
```

No new files. No deletions. No `package.json` change. No new build step (the existing `cp src/ritual_synthesis_prompt.txt lib/` already carries the modified file into the deployed image; `googleapis` is already an installed dep used by `loadCallScript` and `createRitualDoc`).

## Modifications (in phases and steps)

> **What changes inside `ritual_synthesis_prompt.txt` — line by line.**
>
> Every modification below is in `ritual_synthesis_prompt.txt`. **No other file in this directory is touched in any phase.**

### Phase 1 / Step 1 — S1: rename the four top-level XML tags

- **In-file locations (search-and-replace, four pairs):**
  - `<THE STOP>` → `<EXIT FROM THE DAY>` (open + close tags).
  - `<THE CONSCIOUSNESS>` → `<ENTRY INTO THE WORK>` (open + close tags).
  - `<THE INTENTION>` → `<INTENTIONS>` (open + close tags).
  - `<THE COMMITMENT>` → `<THE PACT>` (open + close tags).
  - Apply BOTH in Rule 7's tag-by-tag semantics list AND in the worked example's output AND in the XML template skeleton (if present at the end of the file). Apply replacement on every occurrence, no exceptions.
- **Should NOT be modified:**
  - The semantic descriptions inside Rule 7 for each renamed tag stay verbatim — only the tag name changes. E.g. *"THE STOP / Self-affirmation: the kind, compassionate words…"* becomes *"EXIT FROM THE DAY / Self-affirmation: the kind, compassionate words…"* — the word "the kind, compassionate words…" is untouched.
  - **Sub-tags inside the four blocks DO NOT rename.** `<Self-affirmation>`, `<appreciation-of-little-things>`, `<benefits-hoping-to-gain>`, `<what-do-i-want-to-nurture>`, `<what-do-i-want-to-protect>`, `<immediate>`, `<for-the-day>`, `<for-the-long-run>` — all stay byte-for-byte identical.
  - The worked example's *content* (Thomas's affirmations, his commitments, his intentions) stays verbatim. Only the wrapping tag names move.
- **Explanation:** the call agent reads these tags by name. The matching rename in `flows/call/agent.ts` (C1) absorbs the change in lockstep. See "Deploy sequence" for the safety contract.

### Phase 1 / Step 2 — S2: extend Rule 7's `<Ritual>` semantics for multi-slot rituals

- **In-file location:** Rule 7's `user-details / Ritual` bullet. Currently reads (verbatim): *"user-details / Ritual: the concrete structure and timing of the practice, including frequency, time of day, and ordered steps. Be specific."*
- **Modification:** append ONE new paragraph after that sentence, inside the same bullet:

  > If the ritual has more than one daily activity at distinct times, structure the content as **plain-prose sub-blocks, one per slot**, each opened with the slot's time and activity name. The receiving LLM reads `<Ritual>` at call start and picks the sub-block whose time matches the current dispatch slot. Single-slot rituals stay free-form, as today.

- **Worked example update — in the same step, update the example's `<Ritual>` output** to demonstrate the multi-slot shape. Suggested form (Nashla-shaped; the exact wording is fine to tweak as long as the structure is preserved):

  ```
  <Ritual>
    Morning slot — 8 AM weekdays / 6 AM Tuesdays — Generación de protección:
    Trigger question: "¿Siento que hoy me va a dar gripa?"
    If yes: (1) Avisarle a Hanna. (2) Dormir con Hanna. (3) Estar todo el día con Hanna.
    Accountability: Hanna (hermana), Paul (amigo).

    Afternoon slot — 2 PM daily — Construcción de nueva fe:
    (1) Listar las cosas que no supe cómo hacer hoy.
    (2) Anotar un finding por cada cosa.
  </Ritual>
  ```

- **Should NOT be modified:**
  - The other entries in Rule 7 (Name, Core Motivation, Language, Goal, Context, previous-sessions, the four core blocks' semantics, symbolic-help, social-help) stay verbatim.
  - Rule 10 (`SCHEDULE EXTRACTION`) stays verbatim — `schedules` and `fallbackSchedules` remain flat string arrays of `DAY_HH:MM`. **No per-slot pairing, no activity tagging.**
  - The rest of the worked example (Thomas's affirmations, mantras, prayers, UNMAPPED MATERIAL) stays verbatim. Only the `<Ritual>` sub-tag's content shifts to the multi-slot form, AND only because the example needs to teach the new shape.

### Phase 1 / Step 3 — S3: add a new top-level `<enemy>` tag

- **In-file locations (three):**
  1. **XML template skeleton:** add an empty `<enemy></enemy>` block, sibling to `<user-details>`, BEFORE `<previous-sessions>` in the template's structural order.
  2. **Rule 7:** add one bullet at the top of the existing tag-by-tag list (above the `user-details` entries) — *"`enemy`: the proper-noun name the user gives their adversary, preserved verbatim per Rule 2. Empty if no Enemy is named in the raw material."*
  3. **Worked example output:** add ONE line — either `<enemy>la gripa</enemy>` (if the example is updated to demonstrate a named Enemy) OR `<enemy></enemy>` (if Thomas's example stays as-is and we don't want to fabricate an Enemy for him). **Either is acceptable; the call agent's prompt handles the empty case via the elicit fallback chain — see C2.**
- **Should NOT be modified:**
  - Rule 2 (detachment metaphor preservation) — verbatim. `<enemy>` is the structured carrier; Rule 2's general metaphor-preservation behavior is what fills it.
  - Rule 11 (`behaviorLabel`) — verbatim. `<enemy>` and `behaviorLabel` may or may not match; that's fine.
  - The JSON envelope shape — Rule 9 — verbatim. `<enemy>` lives inside the `userInputs` string, NOT as a top-level field of the JSON envelope.

### Phase 1 / Step 4 — S4: Docs API + tab isolation in `registerNewRitual`

- **In-file locations:** `samwise-backend/cloud-functions/functions/src/index.ts`.
  - New helper `extractTabsAsText` added immediately after `flattenDocToText` (~line 1232 of the post-implementation file). Walks the Docs API `tabs` array (recursive over `childTabs`); for each tab whose trimmed `tabProperties.title` matches a requested title, returns the flattened body text. Returns `{found: Map<string, string>, missing: string[]}`. First-match wins for duplicate-titled tabs.
  - The previous `fetch("/export?format=txt")` block inside `registerNewRitual` (was lines 655–668) is replaced by a Docs API call: `docs.documents.get({ documentId, includeTabsContent: true })`. Two named tab sets are extracted:
    - **Synthesis side:** `["Behavioural picture", "Ritual", "Ritual Call"]` → concatenated as Markdown sections (`# Behavioural picture\n\n…\n\n# Ritual\n\n…\n\n# Ritual Call\n\n…`) into a new `synthesisText` variable.
    - **Metadata side:** `["Metadata"]` → into the existing `docContent` variable (now scoped to metadata regex parsing only).
  - If any of the synthesis tabs are missing, log a BIG warning naming the missing tab(s) and the leak risk, then fall back to `flattenDocToText(doc.data.body?.content ?? [])` for `synthesisText`. Same logic for the Metadata tab.
  - The `enrichedDocContent` construction (was using `${docContent}`) now uses `${synthesisText}` — so the language NOTE injects into the synthesis material, not the metadata text.
- **Should NOT be modified:**
  - `getDocsClient` / `getDriveClient` / `getGoogleAuth` lazy-singletons — verbatim.
  - `flattenDocToText` — verbatim.
  - The Drive title fetch (still unauthenticated `name` field via Drive API) — verbatim.
  - The Metadata regex loop — verbatim (still operates on `docContent`).
  - The Gemini call shape, the `SynthesisResult` interface, the Firestore write — verbatim.
- **Explanation:**
  - The deterministic tab isolation eliminates the leak risk where Gemini would otherwise see `Lapse Map`, `Possible origins`, `Ejemplo de ritual`, etc. — these now never reach the model.
  - The fallback path preserves backwards-compat for any legacy untabbed Doc, but logs loudly so operators see the risk in cloud-functions logs.
  - Backwards-compat note: any pre-existing tabbed Doc that already names its tabs as `Behavioural picture` / `Ritual` / `Ritual Call` / `Metadata` works without any therapist action. Docs that DON'T match will keep working via the whole-Doc fallback, but the warning will surface.

## Testing phase

### Local test (always)

A pure-prompt offline test against a synthetic Doc-text fixture:

1. From `samwise-backend/cloud-functions/functions/`, run `pnpm run build` — must succeed. The prompt file is text; `tsc` is unaffected, but the build's `cp src/ritual_synthesis_prompt.txt lib/` must continue to land the new file in `lib/`.
2. Run the existing emulator path (if available) OR call `registerNewRitual` against a staging Firebase project with a known Doc URL. Confirm:
   - The returned `userInputs` string contains `<EXIT FROM THE DAY>`, `<ENTRY INTO THE WORK>`, `<INTENTIONS>`, `<THE PACT>`, and does NOT contain `<THE STOP>` / `<THE CONSCIOUSNESS>` / `<THE INTENTION>` / `<THE COMMITMENT>`.
   - If the test Doc declares multiple slots (e.g. morning + afternoon), the `<Ritual>` sub-tag carries them as labeled prose sub-blocks.
   - A top-level `<enemy>` tag is present (filled OR empty). Tag presence is the contract.

### Integration test

After cloud-functions deploy (and BEFORE ritual-agent deploy — see Deploy sequence):

- Confirm the deployed `registerNewRitual` URL still returns 200 on a real Doc POST.
- Skim the `userInputs` field of the resulting `rituals/{id}` Firestore document. Eyeball the four new tag names + the new `<enemy>` tag.

### Update README

`samwise-backend/cloud-functions/README.md` (if present) and `google-doc-template.md` — **DO NOT update in this phase.** They are documentation drift sources; updating them couples this proposal to a doc rewrite that's out of scope. Will be revisited in a follow-up task.

---

## Deploy sequence (load-bearing)

S1 (this plan) and C1 (the ritual-agent plan) are a coordinated rename. Between deploys, the synthesized userInputs blob and the agent's expected tag names will not match, and every ritual call in that window will fail the agent's tag lookup. Order:

1. **Land** S1+S2+S3 in `cloud-functions`. **Do not deploy yet.**
2. **Land** C1+C2 in `ritual-agent`. **Do not deploy yet.**
3. **Verify** both branches compile and pass tests locally.
4. **Re-register active rituals** (POST each to `registerNewRitual`) to regenerate `userInputs` against S1's new tag names. OR hold the agent deploy until users naturally re-register. The user will decide.
5. **Deploy `cloud-functions` first**, then `ritual-agent`, in the **same operator session** (no walk-away between).
6. **Confirm** via the agent's `BUILD_TAG` log line that the new agent build is serving, and via a smoke call that the agent reads the renamed tags correctly.

If the user decides NOT to re-register pre-existing rituals, they MUST schedule the agent deploy for a window where no active rituals will fire — otherwise calls between deploys will fall back to elicit-input mode (the agent's existing safety net for empty tags).

---

## After implementation

### Update `samwise-backend/cloud-functions/functions/src/context-for-code-agent.md`

Append a Recent Changes entry dated the implementation date:
- `<THE STOP>` / `<THE CONSCIOUSNESS>` / `<THE INTENTION>` / `<THE COMMITMENT>` were renamed to `<EXIT FROM THE DAY>` / `<ENTRY INTO THE WORK>` / `<INTENTIONS>` / `<THE PACT>` in the synthesis prompt, sub-tags unchanged.
- Rule 7's `<Ritual>` semantics gained a multi-slot prose convention.
- A new top-level `<enemy>` tag was added to `<user-inputs>` to carry the proper-noun adversary name.
- Coordinated with `ritual-agent/src/flows/call/agent.ts` (C1 + C2).

### Update `ritual-synthesis-prompt` skill

In `/Users/samuelgiraldoconcha/.claude/skills/ritual-synthesis-prompt/SKILL.md`:
- The "ten rules at a glance" list does not need to change unless we add an eleventh rule (we are not — the `<enemy>` tag fits under Rule 7's tag-by-tag semantics, and the multi-slot Ritual fits under Rule 7's `<Ritual>` semantics).
- Add a note under "Adding, removing, or renaming a tag" that this round renamed the four core blocks and added `<enemy>`. The skill's existing three-places-to-change-in-lockstep rule (template, Rule 7, example) governed how this was applied.
- Note the coordinated change with the ritual-call agent prompt.

### Mark task DONE

The user manually marks the corresponding task in the master Vibe doc Projects tab.

---

## Strict out-of-scope list (do NOT touch this round)

If you find yourself editing any of the below in this round, STOP — that change does not belong here:

- **Rule 2** (detachment metaphor preservation) — verbatim.
- **Rule 9** (JSON envelope shape) — verbatim. No new top-level field.
- **Rule 10** (schedule extraction) — verbatim. No per-slot activity tags. No fallback pairing.
- **Rule 11** (`behaviorLabel`) — verbatim.
- **Sub-tags inside the four renamed blocks** — verbatim.
- **The `<symbolic-help>` and `<social-help>` blocks** — verbatim. They remain cross-cutting characteristics, not promoted to beats.
- **`registerNewRitual` in `index.ts`** — S4 modifies the Doc-read block AND splits `docContent` into `docContent` (metadata-only) + `synthesisText` (synthesis-only). The Metadata regex parser is otherwise unchanged. `Name:` is NOT added to the required keys.
- **`createRitualDoc` in `index.ts`** — not touched. The canonical template Doc and its metadata pre-fill stay as-is.
- **`extractQualification*` / `extractTrackingKpis` / `loadCallScript`** — not touched.
- **`checkUsersRituals` cron** — not touched. No new dispatch-metadata fields. No per-slot activity routing in the cron.
- **`makeCallsBatchFunction`** — not touched.
- **`google-doc-template.md`** — not touched. Documentation drift will be reconciled in a follow-up task.
- **`package.json` build script** — not touched. `cp src/ritual_synthesis_prompt.txt lib/` already exists and continues to carry the modified file.
- **`.firebaserc`, `firebase.json`, indexes, security rules** — not touched.
