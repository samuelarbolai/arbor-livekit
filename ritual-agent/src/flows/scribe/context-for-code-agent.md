# context-for-code-agent.md — ritual-agent / flows/scribe

> Working notes for the **Scribe** flow — a silent transcription agent inside the
> `ritual-agent` worker. The LiveKit-agent patterns at
> `samwise-backend/ritual-agent/programming-style.md` apply; this file only adds
> what's specific to the scribe.

## Purpose

Human↔human `/meet` calls (walk-in + scheduled) have **no agent**, so nothing
runs STT and the LiveKit session shows **no transcript**. The scribe fills that
gap: it joins the room, runs Deepgram STT on **each human's audio track**, and
publishes each final transcript **labeled to that speaker** via room
transcriptions — which surface in the **LiveKit dashboard**. No LLM, no TTS; it
only listens. (Autonomous demo calls don't need it — the demo-call agent's own
AgentSession already transcribes.)

Scope (decided 2026-06-02): **both speakers, labeled, dashboard, review-only.**
No Firestore/Doc persistence, no extraction yet — those are later upgrades.

## Mechanism (verified against installed SDK — rtc-node 0.13.25, agents 1.2.0)

- `ctx.connect()` defaults to `AutoSubscribe.SUBSCRIBE_ALL` → human audio tracks
  auto-subscribe.
- Per human audio track: `makeStt(lang).stream()` (Deepgram `SpeechStream`) fed
  via `updateInputStream(new AudioStream(track))` (cast bridges a TS
  ReadableStream type-identity mismatch between rtc-node and the agents SDK).
- Read `SpeechEvent`s; on `stt.SpeechEventType.FINAL_TRANSCRIPT` publish
  `room.localParticipant.publishTranscription({ participantIdentity, trackSid,
  segments })` — labeled to the speaker + their track.
- **Node has NO diarization** (`MultiSpeakerAdapter` is Python-only), which is
  why labeling is done per-track rather than on a mixed stream.

## Files

- `transcript.ts` — `transcriptionFromEvent` (event→Transcription mapper) +
  `pumpTranscription` (drain a stream, publish finals). **Pure/testable** — no
  room or STT backend needed.
- `transcript.test.ts` — vitest unit tests (finals labeled correctly; interim /
  empty skipped; publish-failure resilience). The conversational test harness
  doesn't fit a no-LLM scribe, so this is the right form.
- `index.ts` — `runScribeFlow`: connect, transcribe each human track (skip
  `ParticipantKind.AGENT`), 80-min hard cap + 90s no-humans grace shutdown (rides
  out a Phase-1 reconnect, bounds a leaked room).

## Integration touchpoints (outside this flow)

- `src/types/metadata.ts` — `ScribeMeta { flow:'scribe', language }` + parser case.
- `src/main.ts` — router `case 'scribe'`.
- `samwise-app/app/api/walk-in/init/route.ts` — dispatches `flow:'scribe'` for
  **human** calls (create + join), **guarded by `hasAgentDispatch`** so a
  reload doesn't add a second scribe. Autonomous calls dispatch the demo-call
  agent instead.
- Both `VideoCallExperience` copies — presence state counts only `!isAgent`
  remotes, so the scribe joining doesn't flip "Waiting" → "active" or hide
  "peer left".

## Deploy

Needs `lk agent deploy` (new flow code; `BUILD_TAG` bumped). Reads
`DEEPGRAM_API_KEY` (already a secret). No new env vars.
