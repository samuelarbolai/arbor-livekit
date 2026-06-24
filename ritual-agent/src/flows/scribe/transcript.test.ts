import { stt } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { pumpTranscription, transcriptionFromEvent, type TranscriptTarget } from './transcript';

const TARGET: TranscriptTarget = {
  participantIdentity: 'email:leandra@gmail.com-1780350405290',
  trackSid: 'TR_human_audio',
  language: 'en',
};

function final(text: string, startTime = 0, endTime = 1): stt.SpeechEvent {
  return {
    type: stt.SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [{ text, language: 'en', startTime, endTime, confidence: 0.95 }],
  };
}

function interim(text: string): stt.SpeechEvent {
  return {
    type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
    alternatives: [{ text, language: 'en', startTime: 0, endTime: 1, confidence: 0.4 }],
  };
}

describe('transcriptionFromEvent', () => {
  it('maps a final transcript to a Transcription labeled to the speaker + track', () => {
    const t = transcriptionFromEvent(final('I drank yesterday', 2, 4), TARGET);
    expect(t).not.toBeNull();
    expect(t!.participantIdentity).toBe(TARGET.participantIdentity);
    expect(t!.trackSid).toBe(TARGET.trackSid);
    expect(t!.segments).toHaveLength(1);
    expect(t!.segments[0]!.text).toBe('I drank yesterday');
    expect(t!.segments[0]!.final).toBe(true);
    // seconds → integer ms
    expect(t!.segments[0]!.startTime).toBe(2000n);
    expect(t!.segments[0]!.endTime).toBe(4000n);
  });

  it('does NOT publish interim transcripts (only committed finals)', () => {
    expect(transcriptionFromEvent(interim('I dra'), TARGET)).toBeNull();
  });

  it('does NOT publish empty / whitespace finals', () => {
    expect(transcriptionFromEvent(final('   '), TARGET)).toBeNull();
  });
});

describe('pumpTranscription', () => {
  it('publishes one labeled transcription per non-empty final, skipping interim/empty', async () => {
    const events: stt.SpeechEvent[] = [
      interim('I'),
      final('I drank'),
      final('   '),
      interim('then'),
      final('then I stopped'),
    ];
    async function* stream() {
      for (const e of events) yield e;
    }
    const publish = vi.fn().mockResolvedValue(undefined);

    await pumpTranscription(stream(), TARGET, publish);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]![0].segments[0]!.text).toBe('I drank');
    expect(publish.mock.calls[1]![0].segments[0]!.text).toBe('then I stopped');
    expect(publish.mock.calls[0]![0].participantIdentity).toBe(TARGET.participantIdentity);
  });

  it('keeps going when a publish fails — one dropped line never kills the stream', async () => {
    async function* stream() {
      yield final('first');
      yield final('second');
    }
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);

    await expect(pumpTranscription(stream(), TARGET, publish)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
