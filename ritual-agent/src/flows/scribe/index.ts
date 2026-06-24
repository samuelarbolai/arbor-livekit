import { type JobContext, stt } from '@livekit/agents';
import {
  AudioStream,
  ParticipantKind,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Track,
} from '@livekit/rtc-node';
import { makeStt } from '../../config/providers';
import { type ScribeMeta } from '../../types/metadata';
import { pumpTranscription } from './transcript';

// Wall-clock backstop. The scribe never speaks, so there's no idle concept; the
// room's emptyTimeout ends the job once the humans are gone, and the no-humans
// grace below bounds a leaked room to ~90s. This cap is the final guard.
// (samwise-livekit-agents: every web flow needs an unconditional wall-clock cap.)
const HARD_MAX_SESSION_MS = 80 * 60 * 1000;

// After the last human leaves, wait this long before shutting down — long
// enough to ride out a Phase-1 in-session reconnect (seconds) so the scribe
// persists across a brief drop, short enough that a truly-ended call doesn't
// keep a room (and an STT bill) alive for the full hard cap.
const NO_HUMANS_GRACE_MS = 90 * 1000;

// Silent transcription agent. Joins a human↔human /meet room (walk-in or
// scheduled), runs Deepgram STT on EACH human's audio track, and publishes each
// final transcript labeled to that speaker via room transcriptions — which
// surface in the LiveKit dashboard. No LLM, no TTS: it only listens. The
// event→transcription mapping is unit-tested in transcript.ts.
export async function runScribeFlow(ctx: JobContext, meta: ScribeMeta): Promise<void> {
  await ctx.connect(); // SUBSCRIBE_ALL by default → human audio tracks auto-subscribe

  // One STT stream per active audio track, keyed by trackSid (idempotent: a
  // repeat subscribe for a sid already being transcribed is ignored).
  const streams = new Map<string, stt.SpeechStream>();

  // Only HUMANS get transcribed — never the scribe itself (the local
  // participant) or any other agent that might join.
  const isHuman = (p: RemoteParticipant) => p.kind !== ParticipantKind.AGENT;

  const startTrack = (track: Track, sid: string | undefined, participant: RemoteParticipant) => {
    if (!sid || streams.has(sid)) return;
    const speech = makeStt(meta.language).stream();
    streams.set(sid, speech);
    // AudioStream IS a ReadableStream<AudioFrame> structurally; the cast bridges
    // a TS type-identity mismatch between rtc-node's ReadableStream lib and the
    // agents SDK's. updateInputStream then handles the frame pump + resampling.
    speech.updateInputStream(
      new AudioStream(track) as unknown as Parameters<stt.SpeechStream['updateInputStream']>[0],
    );
    void pumpTranscription(
      speech,
      { participantIdentity: participant.identity, trackSid: sid, language: meta.language },
      (t) => ctx.room.localParticipant!.publishTranscription(t),
    ).finally(() => {
      streams.delete(sid);
      try {
        speech.close();
      } catch {
        /* already closed */
      }
    });
    console.log('[scribe] transcribing', { participant: participant.identity, trackSid: sid });
  };

  const stopTrack = (sid: string | undefined) => {
    if (!sid) return;
    const speech = streams.get(sid);
    if (!speech) return;
    try {
      speech.close();
    } catch {
      /* ignore */
    }
    streams.delete(sid);
  };

  ctx.room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (isHuman(participant) && pub.kind === TrackKind.KIND_AUDIO) {
        startTrack(track, pub.sid, participant);
      }
    },
  );
  ctx.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => stopTrack(track.sid));

  // Humans usually join BEFORE the scribe is dispatched, so their audio tracks
  // are already subscribed by the time we attach the handler — pick those up.
  for (const participant of ctx.room.remoteParticipants.values()) {
    if (!isHuman(participant)) continue;
    for (const pub of participant.trackPublications.values()) {
      if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
        startTrack(pub.track, pub.sid, participant);
      }
    }
  }

  // No-humans grace shutdown (see constant above).
  let noHumansTimer: ReturnType<typeof setTimeout> | null = null;
  const clearNoHumansTimer = () => {
    if (noHumansTimer) {
      clearTimeout(noHumansTimer);
      noHumansTimer = null;
    }
  };
  const reviewHumans = () => {
    const present = [...ctx.room.remoteParticipants.values()].some(isHuman);
    if (present) {
      clearNoHumansTimer();
      return;
    }
    if (noHumansTimer) return; // already counting down
    noHumansTimer = setTimeout(() => {
      noHumansTimer = null;
      console.log('[scribe] no humans for grace period — shutting down');
      ctx.shutdown('no_humans');
    }, NO_HUMANS_GRACE_MS);
  };
  ctx.room.on(RoomEvent.ParticipantConnected, reviewHumans);
  ctx.room.on(RoomEvent.ParticipantDisconnected, reviewHumans);
  reviewHumans(); // arm immediately if the scribe somehow joined an empty room

  const hardCap = setTimeout(() => {
    console.warn('[scribe] hard session cap reached — shutting down', {
      durationMs: HARD_MAX_SESSION_MS,
    });
    ctx.shutdown('hard_cap');
  }, HARD_MAX_SESSION_MS);

  ctx.addShutdownCallback(async () => {
    clearTimeout(hardCap);
    clearNoHumansTimer();
    for (const speech of streams.values()) {
      try {
        speech.close();
      } catch {
        /* ignore */
      }
    }
    streams.clear();
  });

  console.log('[scribe] ready', { room: ctx.room.name, language: meta.language });
}
