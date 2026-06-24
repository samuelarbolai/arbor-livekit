// Transcription mapping + the publish pump for flows/scribe. Kept separate from
// index.ts so the core "which STT events become a published transcript, and how
// they're attributed" logic is unit-testable without a live room or STT backend
// (see transcript.test.ts).
import { stt } from '@livekit/agents';
import { type Transcription } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { type Language } from '../../types/metadata';

export interface TranscriptTarget {
  /** Identity of the participant who spoke — the line is attributed to them. */
  participantIdentity: string;
  /** SID of their audio track (LiveKit pairs the transcription to this track). */
  trackSid: string;
  /** Fallback language tag if the STT event doesn't carry one. */
  language: Language;
}

// Map one Deepgram SpeechEvent to a dashboard Transcription attributed to the
// speaking participant + their track. Returns null for everything we DON'T
// publish: non-FINAL events (start/interim/end/usage/preflight) and
// empty/whitespace finals. Publishing only committed finals keeps the dashboard
// transcript clean instead of flickering partials.
export function transcriptionFromEvent(
  ev: stt.SpeechEvent,
  target: TranscriptTarget,
): Transcription | null {
  if (ev.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) return null;
  const alt = ev.alternatives?.[0];
  if (!alt || !alt.text.trim()) return null;
  return {
    participantIdentity: target.participantIdentity,
    trackSid: target.trackSid,
    segments: [
      {
        id: randomUUID(),
        text: alt.text,
        // SpeechData times are seconds; TranscriptionSegment wants integer ms.
        startTime: BigInt(Math.round((alt.startTime ?? 0) * 1000)),
        endTime: BigInt(Math.round((alt.endTime ?? 0) * 1000)),
        language: alt.language ?? target.language,
        final: true,
      },
    ],
  };
}

// Drain an STT event stream, publishing one labeled Transcription per final.
// A publish failure is logged and swallowed — one dropped line must never tear
// down the whole track's transcription. Resolves when the stream ends (track
// unpublished, participant left, or the stream was closed).
export async function pumpTranscription(
  events: AsyncIterable<stt.SpeechEvent>,
  target: TranscriptTarget,
  publish: (t: Transcription) => Promise<void>,
): Promise<void> {
  for await (const ev of events) {
    const transcription = transcriptionFromEvent(ev, target);
    if (!transcription) continue;
    try {
      await publish(transcription);
    } catch (err) {
      console.warn('[scribe] publishTranscription failed', err);
    }
  }
}
