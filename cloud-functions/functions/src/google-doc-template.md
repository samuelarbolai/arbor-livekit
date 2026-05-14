# Google Doc Template — Ritual Definition

Each ritual lives in its own Google Doc, structured as **three tabs**. The cloud function `registerNewRitual` reads the doc, parses the Metadata tab for structured fields, and sends the rest to Gemini for synthesis.

The numbered headings below correspond to tab names.

---

## 1. Problem - Solution

```
I am ******
My core motivation is ******

Problem

* Self-destructive behaviour: *******
* Scary reality: ******

Solution
******

Ritual
********
```

The therapist's framing of the user's situation. Use the user's own metaphor for the core problem ("the disease", "the noise", "the bleeding") — never a clinical label. The synthesis prompt is told to preserve detachment framing as a deliberate psychological tool.

`My core motivation is ******` is the user's personal, life-stakes "because" — what they stand to gain or lose in their actual life if they do or do not change. Distinct from the Solution/Ritual transformation arc: this is the gut-level reason they showed up. The conversational agent reads it back to the user at the very start of the call, so write it in the user's own voice (first person) and keep it to one to three sentences that read well aloud. Preserve their detachment metaphor here too.

For timing, write in plain language ("every night at 9 PM", "weekdays at 7:30 AM"). Gemini converts it to `DAY_HH:MM` keys with a `:00` or `:30` boundary. **Off-boundary times silently never fire.**

---

## 2. Ritual Call

User input for the ritual steps lives here — **the stop**, **the consciousness**, **the intention**, **the commitment**, **symbolic help**, **social help**, plus any prayers, mantras, or meditation questions the user wants recited.

Free-form. Mixed languages are fine; the synthesis prompt translates everything into the call language declared in the Metadata tab.

The synthesis prompt **infers** structure rather than requiring labeled sections — therapists don't need to use specific headers. Optional guidance prompts the therapist can paste in to make sure nothing is missed:

```
== About the user ==
Name, situation, and the core problem in the user's own metaphor.

== The ritual itself ==
What it is, when it happens (day(s) + time on a :00 or :30 boundary),
ordered steps. Fallback slots if any.

== The Stop ==
Self-affirmations. Small things to be grateful for.

== Consciousness ==
What the user hopes to gain. What to nurture inside themselves.
What to protect.

== Intention ==
Immediately after the call. For the rest of the day. For the long run.

== The Commitment ==
The pact. Verbatim phrasing, mantras, covenant language.

== Symbolic help ==
Archetypes, characters, traditions the user draws meaning from.

== Social help ==
The accountability partner, why that person, and the shared practice.

== Prayers / poems / meditation questions ==
Full text of anything to be recited during the call.
```

Long-form content (full poems, prayer texts, meditation question lists) gets routed by the synthesis prompt to its `UNMAPPED MATERIAL` section automatically — paste it in full, the therapist doesn't need to trim.

---

## 3. Metadata

Strict key-value pairs, one per line, values in double quotes. **Every key is required** — the function returns a 400 with the missing field name if any is absent.

```
userID: "pZX1S3FySfgre88oHxHu09JqMGz1"
voiceID: "03496517-369a-4db1-8236-3d3ae459ddf7"
language: "en"
phoneNumber: "+573168248411"
timeZone: "America/Bogota"
```

| Key | Format | Notes |
|---|---|---|
| `userID` | Firebase Auth UID | Therapist looks this up; the function does not generate it. |
| `voiceID` | Cartesia voice UUID | The voice the LiveKit agent will use on the call. |
| `language` | ISO code | `"en"`, `"es"`, etc. Canonical override for what language the call is conducted in. |
| `phoneNumber` | E.164 with country code | e.g. `"+573168248411"`. |
| `timeZone` | IANA timezone | Must match a cron in `checkUsersRituals` for scheduled calls to fire. |

The parser only looks for these five exact keys; anything else in this tab is ignored, but cleaner to keep it minimal.

---

## Schedule format reference

| Field | Day codes | Time | Shape |
|---|---|---|---|
| `schedules` | `SUN MON TUE WED THU FRI SAT` | 24-hour, on `:00` or `:30` boundary | Array of separate strings, e.g. `["MON_21:00", "TUE_21:00"]` |
| `fallbackSchedules` | same | same | same; only fires when `fallbackActive` is `true` (default `false`) |

Examples of how plain-language timing in the Ritual Call tab gets converted:

- "Every night at 9 PM" → `["SUN_21:00", "MON_21:00", "TUE_21:00", "WED_21:00", "THU_21:00", "FRI_21:00", "SAT_21:00"]`
- "Weekdays at 7:30 AM" → `["MON_07:30", "TUE_07:30", "WED_07:30", "THU_07:30", "FRI_07:30"]`
- "Saturdays at 10 AM, fallback Sundays at 10 AM" → schedules: `["SAT_10:00"]`, fallbackSchedules: `["SUN_10:00"]`
