# current-plan.md — Replace loadCallScript's Gemini call with a deterministic parser

## Plan Summary

`loadCallScript` currently sends the flattened Demo Doc text to `gemini-2.5-flash` for parsing into `{ scriptType, phases }`. The prompt itself instructs Gemini to use `[SAY]/[/SAY]` markers DETERMINISTICALLY — i.e. as exact text tokens. That means Gemini is doing no real reasoning anymore; it's a regex job dressed up as an LLM call. The cost is 5–15s of latency per script load (sometimes more), a 120s timeout exposure, and a non-deterministic dependency.

This plan rips out the Gemini call and replaces it with a pure TypeScript `parseScript(title, content)` function. Output JSON shape is byte-identical to today's — frontend, localStorage v2 sessions, and the script-pane renderer require no changes.

The canonical Demo Doc (`1sBHuGaXCFaP8cmQdUgNpoQYwCq3L4-OfDMDoPR73a5g`) already starts with a literal `[TYPE: demo]` line, so scriptType detection is exact (with a keyword fallback for older Docs that lack the marker).

## Plan Architecture (Flow)

1. Frontend POSTs `{ googleDocLink }` to `loadcallscript-…cloudfunctions.net`. **Unchanged.**
2. `loadCallScript` extracts the Doc ID, calls Docs API → returns `doc.data`. **Unchanged.**
3. `loadCallScript` calls `flattenDocToText(doc.data.body?.content ?? [])` → flat text. **Unchanged.**
4. `loadCallScript` calls `parseScript(title, content)` → `{ scriptType, phases }`. **NEW** (replaces Gemini round-trip).
5. Handler returns `res.status(200).json(parsed)`. **Unchanged.**

The Gemini call, the `LOAD_SCRIPT_PROMPT` constant, the `load_call_script_prompt.txt` file, the prompt-fill template-replace, the JSON.parse-of-Gemini-response branch, and the `timeoutSeconds: 120` override all disappear.

## Plan Structure (Directories and files)

```
samwise-backend/cloud-functions/functions/
├── package.json                                # MODIFIED: drop load_call_script_prompt.txt from build cp
└── src/
    ├── index.ts                                # MODIFIED: add parseScript(); rewire loadCallScript;
    │                                           #           remove LOAD_SCRIPT_PROMPT + fs/path reads
    ├── load_call_script_prompt.txt             # DELETED
    ├── context-for-code-agent.md               # MODIFIED: add Recent Changes entry
    └── current-plan.md                         # THIS FILE
```

External skill update (outside this module):
- `/Users/samuelgiraldoconcha/Documents/samwise/.claude/skills/samwise-session-copilot/SKILL.md` — update the `loadCallScript` row in the function table and add a note under "Where things live" about the parser.

---

## Modifications (in phases and steps)

### Phase 1 / Step 1 — Add `parseScript` to `index.ts`

- **In-file location:** Insert immediately after `flattenDocToText` (currently ends at line 1231) and BEFORE the `loadCallScript` export (line 1244). Drops in at ~line 1232.
- **Should not be modified:**
  - `flattenDocToText` itself (lines 1209–1231) — keeps doing what it does today.
  - `extractDocId` (lines 1197–1201).
  - The `getGoogleAuth` / `getDriveClient` / `getDocsClient` singletons (lines 480–540 region).
  - Any other function in the file.
- **Code:**

```ts
/* eslint-disable max-len */
/**
 * parseScript — deterministic Doc-text → {scriptType, phases} parser.
 *
 * Replaces the Gemini-backed parse in loadCallScript. The Doc uses three
 * explicit conventions that make this a pure string job:
 *
 *   - `[TYPE: demo]` / `[TYPE: onboarding]` / `[TYPE: call_design]` —
 *     optional standalone line near the top of the Doc. When present, it's
 *     authoritative. Falls back to title/content keyword matching.
 *
 *   - Phase headings — lines matching `Phase N — title` or `Phase N.M — title`
 *     (em-dash, en-dash, or hyphen accepted). Decimal phases keep their
 *     string form ("1.5", "8.5"); integer phases emit as `number`.
 *
 *   - Pre/Post boundaries — `Pre-call …` / `Precall …` opens a phase with
 *     `number: "pre-call"`. `After the call …` / `Post-call …` opens
 *     `number: "post-call"` (note: the Demo Doc places "After the call" in
 *     the middle of the document — phase order is document order, not
 *     numeric order).
 *
 *   - Body blocks — split deterministically on `[SAY]` / `[/SAY]` text
 *     tokens. Inside markers → "say" block. Outside → "note" block.
 *     `[CONDITION: var=value]` lines stay inside note blocks; the frontend
 *     filters them per-line in script-pane.tsx.
 *
 * Anything before the first phase heading is dropped (preamble — Duration,
 * Goal, Variable syntax, etc.). Trailing non-phase content after the last
 * phase boundary belongs to that last phase's body (the SAY-state machine
 * handles it naturally).
 *
 * @param {string} title Doc title from docs.documents.get → data.title.
 * @param {string} content Flattened Doc text from flattenDocToText.
 * @return {{scriptType: ScriptType, phases: ParsedPhase[]}} Same shape as
 *   the previous Gemini output.
 */
type ScriptType = "demo" | "onboarding" | "call_design" | "unknown";
type ParsedBlock = { kind: "say" | "note"; text: string };
type ParsedPhase = {
  number: number | string;
  title: string;
  blocks: ParsedBlock[];
};

const TYPE_MARKER_RE = /\[TYPE:\s*(demo|onboarding|call_design)\s*\]/i;
const PHASE_RE = /^\s*Phase\s+(\d+(?:\.\d+)?)\s*[—–-]\s*(.+?)\s*$/;
const PRECALL_RE = /^\s*Pre-?call\b.*$/i;
const POSTCALL_RE = /^\s*(?:After the call|Post-?call)\b.*$/i;
// Split on both straight and full-width brackets; Google Docs sometimes
// autocorrects `[` to `［`. Keep both branches.
const SAY_SPLIT_RE = /(\[\/?SAY\]|［\/?SAY］)/;

function detectScriptType(title: string, content: string): ScriptType {
  // Marker takes priority — exact, authoritative.
  const head = content.slice(0, 500);
  const m = head.match(TYPE_MARKER_RE) ?? title.match(TYPE_MARKER_RE);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === "demo" || v === "onboarding" || v === "call_design") return v;
  }
  // Keyword fallback for Docs without the marker.
  const haystack = `${title}\n${head}`.toLowerCase();
  if (/demo call|compatibility & welcome/.test(haystack)) return "demo";
  if (/dra\.\s*ana\s*mar[ií]a|onboarding/.test(haystack)) return "onboarding";
  if (/call\s+design|ritual\s+design/.test(haystack)) return "call_design";
  return "unknown";
}

function splitPhaseBody(body: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let mode: "say" | "note" = "note";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("").trim();
    if (text) blocks.push({kind: mode, text});
    buf = [];
  };
  for (const part of body.split(SAY_SPLIT_RE)) {
    if (!part) continue;
    const norm = part
      .replace("［", "[")
      .replace("］", "]");
    if (norm === "[SAY]") {
      flush();
      mode = "say";
    } else if (norm === "[/SAY]") {
      flush();
      mode = "note";
    } else {
      buf.push(part);
    }
  }
  flush();
  // Merge consecutive same-kind blocks (defensive — shouldn't happen from
  // the state machine alone, but a stray empty [SAY][/SAY] pair could).
  const merged: ParsedBlock[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.kind === b.kind) {
      last.text = `${last.text}\n${b.text}`.trim();
    } else {
      merged.push({...b});
    }
  }
  return merged;
}

interface PhaseHeading {
  number: number | string;
  title: string;
}

function matchPhaseHeading(line: string): PhaseHeading | null {
  const m = PHASE_RE.exec(line);
  if (m) {
    const numStr = m[1];
    const number: number | string = numStr.includes(".") ?
      numStr :
      parseInt(numStr, 10);
    return {number, title: m[2].trim()};
  }
  if (PRECALL_RE.test(line)) {
    return {number: "pre-call", title: line.trim()};
  }
  if (POSTCALL_RE.test(line)) {
    return {number: "post-call", title: line.trim()};
  }
  return null;
}

export function parseScript(
  title: string,
  content: string,
): {scriptType: ScriptType; phases: ParsedPhase[]} {
  const scriptType = detectScriptType(title, content);

  const lines = content.split(/\r?\n/);
  type Bucket = PhaseHeading & {bodyLines: string[]};
  const buckets: Bucket[] = [];
  let current: Bucket | null = null;

  for (const line of lines) {
    const heading = matchPhaseHeading(line);
    if (heading) {
      current = {...heading, bodyLines: []};
      buckets.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
    // Lines before the first heading are dropped (preamble).
  }

  const phases: ParsedPhase[] = buckets
    .map((b) => ({
      number: b.number,
      title: b.title,
      blocks: splitPhaseBody(b.bodyLines.join("\n")),
    }))
    .filter((p) => p.blocks.length > 0);

  return {scriptType, phases};
}
/* eslint-enable max-len */
```

- **Explanation:**
  - **`detectScriptType`** — checks the first 500 chars of content for `[TYPE: ...]`, then the title. Falls back to keyword matching (the same heuristic the Gemini prompt used). The Demo Doc already has `[TYPE: demo]` so it takes the deterministic branch.
  - **`matchPhaseHeading`** — runs all three regexes per line. `PHASE_RE` accepts em-dash (—), en-dash (–), and hyphen (-) as the separator. Decimal numbers stay strings; integers convert to `number`. The Demo Doc uses em-dash throughout — verified against the actual Doc content.
  - **`splitPhaseBody`** — single-pass state machine. The split-regex captures both straight and full-width SAY markers as separate parts; the loop normalizes them and flips mode. The merge-adjacent pass at the end is defensive (empty `[SAY][/SAY]` pairs).
  - **The phase loop** — accumulates each phase's body lines in document order. Anything before the first heading is silently dropped (preamble: Duration, Goal, Variable syntax notes — not part of the rendered script).
  - **`.filter(p => p.blocks.length > 0)`** — empty phases (e.g. a trailing heading with no body) get dropped. The current Gemini parser does the same.
  - **The Demo Doc's quirks** — Phase 2 is missing (script jumps 1.5 → 3), `After the call` sits between Phase 12 and Phase 13, `Quick variable reference` trails Phase 17. The parser emits everything in document order without sequential validation. The `Quick variable reference` block doesn't match any phase heading and isn't inside a phase body, so it gets dropped naturally (no current phase, content discarded). Subsections like `5a.`, `5b.`, `Step 1 — Anchor on the qualify moment`, `### Reflect` don't match `PHASE_RE` (they don't start with `Phase`) — they stay inside their parent phase's body as part of note blocks.

### Phase 1 / Step 2 — Rewire `loadCallScript`

- **In-file location:** `samwise-backend/cloud-functions/functions/src/index.ts` lines 1244–1293 (the `loadCallScript` export).
- **Should not be modified:**
  - The `extractDocId` call, the `getDocsClient` call, the `docs.documents.get` call, `flattenDocToText` invocation, the early 400 guard on missing `googleDocLink`, the surrounding try/catch shape, the 500 fallback. Drive read path stays intact.
  - The function URL hash — the export name `loadCallScript` is unchanged, so `loadcallscript-b6fhjlgejq-uc.a.run.app` keeps resolving and the frontend's `lib/copilot/load-script.ts` URL constant requires no change.
- **Code (full replacement of the export body):**

```ts
/**
 * loadCallScript (HTTP)
 *
 * Body: { googleDocLink: string }
 *
 * Reads the Doc via the Google Docs API, parses it deterministically into
 * { scriptType, phases }. The Doc uses [SAY]/[/SAY] text markers around
 * spoken lines and "Phase N — title" headings — see parseScript() above.
 *
 * Used by samwise-app/app/copilot/ at session start.
 */
export const loadCallScript = onRequest(
  {cors: true},
  async (req, res) => {
    interface LoadCallScriptBody {
      googleDocLink: string;
    }

    try {
      const {googleDocLink} = req.body as LoadCallScriptBody;
      if (!googleDocLink) {
        res.status(400).json({error: "googleDocLink required"});
        return;
      }

      const docId = extractDocId(googleDocLink);
      const docs = getDocsClient();
      const doc = await docs.documents.get({documentId: docId});

      const title = doc.data.title ?? "";
      const content = flattenDocToText(doc.data.body?.content ?? []);

      const parsed = parseScript(title, content);
      res.status(200).json(parsed);
    } catch (err) {
      logger.error("loadCallScript failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  },
);
```

- **Explanation:**
  - The `timeoutSeconds: 120` override is dropped — Drive read is the only remaining slow path (~1–3s typical). Default Cloud Functions timeout suffices.
  - The Gemini call, the `LOAD_SCRIPT_PROMPT.replace(...)` lines, the `new GoogleGenerativeAI(...)` instantiation, the `model.generateContent(...)` call, and the JSON.parse-with-502-on-failure branch are all removed.
  - The 502 error path goes away — there's no longer a layer that can return non-JSON.

### Phase 1 / Step 3 — Remove `LOAD_SCRIPT_PROMPT` constant + its imports

- **In-file location:** lines 462–465 of `index.ts`:
  ```ts
  const LOAD_SCRIPT_PROMPT = fs.readFileSync(
    path.join(__dirname, "load_call_script_prompt.txt"),
    "utf8",
  );
  ```
- **Should not be modified:** the other prompt file reads (`ritual_synthesis_prompt.txt`, `extraction_qualification_prompt.txt`, `extraction_tracking_prompt.txt`) all stay. The top-of-file `import fs from "fs"` / `import path from "path"` (or however they're spelled in the file) stays — used by the other prompt readers.
- **Code:** delete the four-line block. Also delete the standalone comment block immediately above it (lines 458–460) that describes the prompt's purpose.
- **Explanation:** straightforward removal. No reference to `LOAD_SCRIPT_PROMPT` will remain after Step 2.

### Phase 1 / Step 4 — Delete `load_call_script_prompt.txt`

- **File:** `samwise-backend/cloud-functions/functions/src/load_call_script_prompt.txt`.
- **Action:** delete.
- **Explanation:** unused after Step 3. Keeping it as a graveyard reference is anti-pattern; the prior content is recoverable from git.

### Phase 1 / Step 5 — Drop the prompt file from the build copy step

- **File:** `samwise-backend/cloud-functions/functions/package.json`.
- **Change:** in the `build` script, remove `&& cp src/load_call_script_prompt.txt lib/`.
- **Before:**
  ```
  "build": "tsc && cp src/ritual_synthesis_prompt.txt lib/ && cp src/load_call_script_prompt.txt lib/ && cp src/extraction_qualification_prompt.txt lib/ && cp src/extraction_tracking_prompt.txt lib/"
  ```
- **After:**
  ```
  "build": "tsc && cp src/ritual_synthesis_prompt.txt lib/ && cp src/extraction_qualification_prompt.txt lib/ && cp src/extraction_tracking_prompt.txt lib/"
  ```
- **Explanation:** without the source file, `cp` would fail and break every build.

---

## Testing phase

### Local test (always)

A pure-function offline test against a fixture of the actual Demo Doc text:

1. From `samwise-backend/cloud-functions/functions/`, run `pnpm run build` — must succeed with no TypeScript errors. (`parseScript` has explicit signatures; tsc verifies the return shape.)
2. Spin a Node REPL or one-off script that requires the built `lib/index.js`, calls `parseScript(title, content)` with a stub of the canonical Doc text (paste a representative excerpt — Phase 1 through Phase 1.5, plus Phase 8.5 and Phase 12, plus "After the call" — into a JS string), and prints the JSON output.

   **Pass criteria:**
   - `scriptType === "demo"`.
   - `phases.map(p => p.number)` contains `1`, `"1.5"`, `3`, `4`, `5`, `6`, `7`, `8`, `"8.5"`, `9`, ..., `"post-call"`, `13`, ..., `17` in document order. (Phase 2 is absent — that's correct.)
   - Phase 1's blocks include a `kind: "say"` block whose text starts with `Hola. Que bueno tenerte aquí.` and DOES NOT contain the literal `[SAY]` or `[/SAY]` strings.
   - Phase 9's first note block contains `[CONDITION: fit_state=qualified]` as one of its lines (the frontend filter relies on this surviving).
   - `{{behaviour_to_change}}`, `{{core_motivation}}`, `{{symbolic_anchor_description}}` placeholders are preserved EXACTLY inside say-block text.
   - Phase 8.5's `number === "8.5"` (string form).
   - The post-call phase has `number === "post-call"` and contains the "outcome / next_step / rep_notes" content.

3. Quick negative test: pass a content string that does not contain `[TYPE:]` and has no recognizable keywords → expect `scriptType === "unknown"`. Pass an empty content → expect `phases === []`.

### Integration test

After deploy:
- Open `/copilot` in samwise-app, paste the canonical Demo Doc URL, click load.
- Expect: load completes in ~1–3s instead of 5–15s. The visual output (phases, say cards, note prose, condition-filtered phases when `fit_state` toggles) is identical to what Gemini produced. Test the qualified vs still_disqualified branches by flipping `fit_state` in the variables-table — Phases 9–15 hide/show vs Phases 16–17.

### Update README

The `samwise-backend/cloud-functions/` README does not currently document `loadCallScript`'s internals (only its existence). The internal switch from Gemini to a parser is documented in (a) the inline JSDoc on `parseScript`, (b) the `samwise-session-copilot` skill, and (c) the Recent Changes entry in `context-for-code-agent.md`. Skip README edit.

---

## After implementation

### Update `samwise-backend/cloud-functions/functions/src/context-for-code-agent.md`

Append a new entry to the "Recent Changes" section dated 2026-05-26:
- The Gemini call inside `loadCallScript` was removed in favour of a pure `parseScript()` function. Doc convention (`[TYPE: demo]` marker + `Phase N — title` headings + `[SAY]/[/SAY]` text markers) is deterministic enough that the LLM is doing no real reasoning. Latency drops from 5–15s to ~1–3s (Drive read only). The `load_call_script_prompt.txt` file and its build-time copy are deleted. The function URL is unchanged.

Update the `loadCallScript` row in the Module Overview section: drop the "asks Gemini to parse it" / "Model gemini-2.5-flash, timeoutSeconds: 120" wording; replace with "parses it deterministically via `parseScript()` using `[SAY]/[/SAY]` and `Phase N — title` markers."

### Update `samwise-session-copilot` skill

In `/Users/samuelgiraldoconcha/Documents/samwise/.claude/skills/samwise-session-copilot/SKILL.md`:
- Update the `loadCallScript` row in the three-functions table — drop the "Gemini parse" and "Model gemini-2.5-flash, timeoutSeconds: 120" mentions; replace with "deterministic `parseScript()` in TypeScript — no LLM."
- Add a short note under "The three cloud functions" stating that the parser swap happened 2026-05-26 and the contract (output JSON shape) is unchanged.
- The `[SAY]/[/SAY]` marker convention section stays untouched — it's now load-bearing for the parser (was load-bearing for Gemini's deterministic instruction before).

### Mark task DONE

User manually marks the corresponding task in the master Vibe doc Projects tab.
