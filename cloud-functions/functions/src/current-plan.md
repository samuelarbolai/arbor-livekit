# current-plan.md — Improve the copilot, backend side (cleanVariable synthesis)

## Plan Summary

One bug, one file, one function. The `cleanVariable` cloud function (defined in `index.ts`) builds its Gemini prompt via the helper `buildCleanVariablePrompt`. One rule in that helper's RULES block — *"Preserve the prospect's specific framing. Do NOT collapse a vivid concrete description into a generic abstract noun"* — fires too hard. Gemini reads it as "leave the rep's wording roughly as-is," so the `Cleaned:` output is a paraphrase of the raw note rather than the tight slot-fit phrase the script needs.

The user's complaint, verbatim: *"the cleaned version is actually just a better written version of the same input. That means I am not getting the value of a cleaned variable, which is to have it synthesize, from a brain dump, so I can use it in the context of the script right away."*

**Fix:** swap the offending rule. The new RULES block explicitly tells Gemini to SYNTHESIZE to the shortest phrase that fits all script slots, while still protecting (a) the prospect's voice, (b) their detachment metaphor, and (c) verbatim-quote variables. The slot-context block already in the prompt (`SCRIPT SLOTS where {{var}} appears`) is the grammatical anchor — Gemini picks the form that fits.

Sister plan at `samwise-app/current-plan.md` covers the stale-state-bleed bug in the frontend. This sub-plan covers ONLY the prompt edit.

## Plan Architecture (Flow)

1. Frontend posts `{ name, rawValue, frameworkSemantics, scriptContexts, otherVariables }` to `cleanvariable-b6fhjlgejq-uc.a.run.app`. **Unchanged.**
2. `cleanVariable` (HTTP handler) calls `buildCleanVariablePrompt(body)`. **Unchanged.**
3. `buildCleanVariablePrompt` returns the prompt string. **RULES block edited.**
4. Gemini Flash returns the cleaned phrase. **Unchanged.**
5. Handler strips wrapping quotes and returns `{ cleaned }`. **Unchanged.**

No contract change, no new function, no new env var.

## Plan Structure (Directories and files)

```
samwise-backend/cloud-functions/functions/src/
└── index.ts            # MODIFIED: buildCleanVariablePrompt RULES block
```

One file, one block.

---

## Modifications (in phases and steps)

### Phase 1 / Step 1 — Replace the RULES block in `buildCleanVariablePrompt`

- **In-file location:** `samwise-backend/cloud-functions/functions/src/index.ts`, lines 1329–1348 (the template-literal `return` of `buildCleanVariablePrompt`, specifically the `RULES:` section starting after the `RAW REP NOTE:` block).
- **Should not be modified:**
  - The function signature `function buildCleanVariablePrompt(body: { name, rawValue, frameworkSemantics?, scriptContexts?, otherVariables? }): string` (line 1294).
  - The `semantics` / `contextBlock` / `otherBlock` builder logic (lines 1301–1327). The slot-context and cross-variable disambiguation are correct; only the RULES section needs to change.
  - The `WHAT THIS VARIABLE CAPTURES:` / `SCRIPT SLOTS:` / `OTHER VARIABLES:` / `RAW REP NOTE:` headers in the template literal.
  - The `CLEANED PHRASE:` trailing prompt marker.
  - The `cleanVariable` HTTP handler itself (lines 1363–1401) — handler logic, env reading, error handling, response shape all stay the same.
  - The `/* eslint-disable max-len */` / `/* eslint-enable max-len */` pragma pair around the helper.
- **Code (full replacement of the `return` template literal in `buildCleanVariablePrompt`):**

```ts
  return `You are cleaning a rep's raw mid-call note into a phrase that will populate variable {{${body.name}}} in a Samwise call script. The rep reads the script aloud right now — your output's job is to be the right thing to SAY in this specific call.

WHAT THIS VARIABLE CAPTURES:
${semantics}

${contextBlock}
${otherBlock}
RAW REP NOTE:
"""
${body.rawValue}
"""

RULES:
- SYNTHESIZE — DO NOT PARAPHRASE. The rep's raw note is a brain dump: long, redundant, conflated, mid-thought. Your job is to extract the tightest noun or verb phrase that fits ALL the script slots above and drop everything else. If the raw note is 30 words and the slot calls for a 4-word phrase, return 4 words. The slot-fit test is the size budget — your output must read cleanly when the rep says the slot sentence aloud, with no padding or rewinds. A paraphrase that is roughly the same length as the raw note is a FAILURE.
- Extract ONLY content relevant to THIS variable. The rep's note may conflate multiple variables — strip anything that belongs elsewhere. Example: if the rep mixes the behaviour, biographical context, and the life-stakes reason, and this variable is core_motivation, output only the life-stakes reason.
- Preserve the prospect's voice and their chosen framing. Tightening the phrase is REQUIRED; replacing the prospect's specific words with a generic clinical noun is NOT. If the prospect said "salir con mujeres mediocres", output "salir con mujeres mediocres" — NEVER collapse to "incumplimiento" or "conformismo". If the prospect described their problem as "mi enemigo", "the bleeding", "my disease", "la enfermedad", keep that detachment metaphor verbatim. NEVER substitute clinical terms ("addiction", "depression", "anxiety", "ADHD") into the output. You may reason clinically internally; the output protects the prospect's chosen framing because the rep reads it aloud to them.
- Use the OTHER VARIABLES block above ONLY to disambiguate ambiguous wording in the rep's note (e.g. "defaulting" — financial breach? settling-for-default option?). NEVER pull content from other variables into your output; that content belongs to those other variables.
- If the raw note does not contain content for THIS variable (the rep typed into the wrong field), return the raw note unchanged. NEVER fabricate. NEVER infer from other variables.
- Return ONLY the cleaned phrase. No labels, no JSON, no commentary, no surrounding quotes.

CLEANED PHRASE:`;
```

- **Explanation:**
  - The first rule is the load-bearing change: it names SYNTHESIS as the goal, explicitly rejects paraphrase, and gives Gemini a concrete length test (*"a paraphrase roughly the same length as the raw note is a FAILURE"*). This addresses the user's exact complaint.
  - The second rule (extract relevant content only) is preserved verbatim from the previous prompt — it's the conflation defense.
  - The third rule replaces the old *"Preserve the prospect's specific framing. Do NOT collapse a vivid concrete description into a generic abstract noun"* with a sharper version. Both clauses are still there in spirit (voice + metaphor protection, no clinical substitution), but the "DO NOT collapse" half is removed because that's exactly what Gemini was misreading as "DO NOT synthesize." The new phrasing tells Gemini that **tightening is required, what's forbidden is replacing the prospect's words with a generic abstract noun** — which is a much narrower restriction.
  - The fourth rule (`otherVariables` is for disambiguation only) is preserved verbatim.
  - The fifth rule is split: previously "If the raw note does not contain content for THIS variable, return the raw note unchanged. NEVER fabricate." The new version adds "NEVER infer from other variables" to seal a gap where Gemini might pull from `otherVariables` content as a fabrication crutch (low likelihood, but cheap to seal).
  - Sixth rule (output format: just the phrase, no wrappers) is preserved.

#### Phase 1 / Step 2 — Local test (curl)

Before deploying, smoke-test the prompt locally against the live Gemini API. From `samwise-backend/cloud-functions/functions/`:

```bash
pnpm run build && pnpm run serve   # emulator, port 5001 by default
```

In another shell, hit the emulator with David's actual `core_motivation` raw:

```bash
curl -X POST 'http://localhost:5001/<project-id>/us-central1/cleanVariable' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "core_motivation",
    "rawValue": "to accomplish my other projects, to continue investing in my life, health, mind, learning, and connections, and to not forget my purpose and non-negotiables, all with a clear and tranquil mind",
    "frameworkSemantics": "The deeper life-stakes reason the prospect wants to change. NOT the behaviour, NOT biographical context — the why behind everything else.",
    "scriptContexts": [
      "…porque querés {{core_motivation}}.",
      "Y realmente necesitás resolver esto porque querés {{core_motivation}}."
    ]
  }'
```

**Pass criterion:** the returned `cleaned` is noticeably SHORTER than the raw (target: ≤25 words vs raw ~45 words), is Spanish (matching the slot context), preserves a thrust of David's enumeration (projects, life, health, purpose), and reads grammatically when substituted into the two slots above.

**Fail signals to fix and retry:**
- Returned phrase is the same length or longer than raw → tighten the SYNTHESIZE rule with even more explicit "DROP filler" examples.
- Returned phrase loses David's voice (e.g. collapses to "vivir mejor") → tighten the "preserve voice" rule.
- Returned phrase is in English → check that the script-context Spanish is being rendered correctly into the prompt.

Repeat curl with `behaviour_to_change` raw = `"getting unstuck"` → expect a short Spanish phrase (`estar estancado` / `salir del estancamiento`).

Repeat curl with `symbolic_anchor_description` raw = `"Nietzsche, the idea of the superhuman, and the obligation to be critical and think twice about what the system tells me, also aestheticism"` and slot context (read from the script Doc) → expect short Spanish that retains Nietzsche / superhombre / crítica.

#### Phase 1 / Step 3 — Deploy

From `samwise-backend/cloud-functions/functions/`:

```bash
pnpm run build && firebase deploy --only functions:cleanVariable
```

The function URL hash (`cleanvariable-b6fhjlgejq-uc.a.run.app`) does NOT change on redeploy when only the function body changes — frontend constant in `samwise-app/lib/copilot/clean-variable.ts` requires no update.

#### Phase 1 / Step 4 — Integration test

Covered by Phase 3 of the frontend sister plan (load David's qualification end-to-end in `/copilot`). No additional integration test needed on the backend side.

#### Phase 1 / Step 5 — Update README

`samwise-backend/cloud-functions/` has a README. The README does NOT currently document `cleanVariable`'s exact prompt behavior — it would couple the README to the prompt, which is the wrong layer to document there. The synthesis-vs-paraphrase decision is documented (a) in this `current-plan.md`, (b) in code comments adjacent to `buildCleanVariablePrompt`, and (c) in the `samwise-session-copilot` skill ("Tuning the cleaning" section). Skip README edit.

---

## Testing phase

### Local test (always)

Phase 1 / Step 2 above — curl against the local emulator with David's three real raw values.

### Integration test

Frontend sister plan's Phase 3 — end-to-end load of David's qualification into `/copilot`, screenshot proof.

### Update README

Skipped — see Phase 1 / Step 5.

---

## After implementation

### Update `samwise-backend/cloud-functions/functions/src/context-for-code-agent.md`

No structural change to the module — same files, same exports, same env vars. The prompt edit is documented in code comments at `buildCleanVariablePrompt`. Skip.

### Update `samwise-session-copilot` skill

Append a short note under section "1. Cleaning aims for script-fit, not canonical-generic form": *"Updated 2026-05-21: synthesis is REQUIRED, not optional. The previous 'do not collapse a vivid description into a generic abstract noun' rule was too conservative — Gemini read it as 'do not synthesize.' The new rule keeps voice and metaphor protection but explicitly names paraphrase-without-shortening as a failure."* Done as a quick skill edit after the fix lands.

### Mark task DONE

User manually marks **"Improve the copilot"** as **DONE** in the master Vibe doc Projects tab.
