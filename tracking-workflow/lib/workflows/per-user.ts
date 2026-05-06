import { createWorkflow } from '@upstash/workflow/nextjs';
import { db } from '@/lib/firestore';
import { livekitDispatch } from '@/lib/livekit';
import {
  allRitualsComplete,
  type TrackingEvent,
} from '@/lib/tracking-events';

// Per-user tracking run. Invoked from the root workflow's per-tz fan-out
// (Phase 6) via context.invoke. Phase 2 implemented the idempotency
// check; Phase 3 added the LiveKit dispatch step + waitForEvent. Phase 4
// will branch into the SMS chat fallback when voice didn't fully cover
// the user's rituals; Phase 5 will write the final state and send the
// link.
//
// Phase 6 (2026-05-06) moved this from `serve()` at
// app/api/tracking-workflow/per-user/route.ts into `createWorkflow` so
// it can be co-mounted with rootWorkflow under a single serveMany. URL
// stays the same (`/api/tracking-workflow/per-user`) because the
// catch-all route maps the segment to the serveMany key.
//
// context.workflowRunId is the canonical correlation ID — embedded in
// the dispatch metadata as `run_id`, echoed back by the tracking-agent
// in its shutdown POST, used by /api/tracking-callback to call
// client.notify('tracking-call-result-<runId>'), and waited on here.
// The PerUserPayload also carries `runId` (the parent root run's ID)
// purely for traceability — it is NOT what the agent or callback uses.

export interface PerUserPayload {
  userID: string;
  runId: string;
  tz: string;
  round: 'primary' | 'retry';
}

interface UserDoc {
  userID: string;
  phoneNumber: string;
  language: string;
  voiceID: string;
  timeZone: string;
  ritualLabels: Record<string, string>;
}

export const perUserWorkflow = createWorkflow<PerUserPayload, void>(async (context) => {
  const { userID, runId, tz, round } = context.requestPayload;
  const wfRunId = context.workflowRunId;
  console.log('[per-user] invoke', { wfRunId, userID, runId, tz, round });

  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const eventDocId = `${userID}_${date}`;
  console.log('[per-user] eventDocId', { wfRunId, eventDocId });

  const alreadyComplete = await context.run('idempotency-check', async () => {
    console.log('[per-user/idempotency-check] enter', { wfRunId, eventDocId });
    const snap = await db().collection('trackingEvents').doc(eventDocId).get();
    const exists = snap.exists;
    const complete = exists ? allRitualsComplete(snap.data() as TrackingEvent) : false;
    console.log('[per-user/idempotency-check] result', {
      wfRunId,
      exists,
      complete,
    });
    return complete;
  });

  if (alreadyComplete) {
    console.log('[per-user] already complete, skipping', { wfRunId, eventDocId });
    return;
  }

  const user = await context.run('load-user', async () => {
    console.log('[per-user/load-user] enter', { wfRunId, userID });
    const snap = await db().collection('users').doc(userID).get();
    if (!snap.exists) {
      console.error('[per-user/load-user] users doc missing', { wfRunId, userID });
      throw new Error(`users/${userID} not found`);
    }
    const data = snap.data() as UserDoc;
    console.log('[per-user/load-user] loaded', {
      wfRunId,
      userID,
      phoneNumber: data.phoneNumber,
      language: data.language,
      voiceID: data.voiceID,
      timeZone: data.timeZone,
      ritualCount: Object.keys(data.ritualLabels ?? {}).length,
      ritualIds: Object.keys(data.ritualLabels ?? {}),
    });
    return data;
  });

  await context.run('dispatch-tracking-call', async () => {
    console.log('[per-user/dispatch] enter', { wfRunId });
    const callbackUrl = process.env.TRACKING_CALLBACK_URL;
    if (!callbackUrl) {
      console.error('[per-user/dispatch] TRACKING_CALLBACK_URL not set', { wfRunId });
      throw new Error('TRACKING_CALLBACK_URL is not set');
    }

    const rituals = Object.entries(user.ritualLabels).map(
      ([googleDocId, label]) => ({ googleDocId, label }),
    );

    const roomName = `tracking-${wfRunId}`;
    const metadata = {
      user_id: userID,
      phone_number: user.phoneNumber,
      language: user.language,
      voice_id: user.voiceID,
      room_name: roomName,
      run_id: wfRunId,
      tracking_callback_url: callbackUrl,
      rituals,
    };
    console.log('[per-user/dispatch] metadata', {
      wfRunId,
      roomName,
      ritualCount: rituals.length,
      callbackUrl,
      // phone is sensitive but useful for confirming routing — keep it
      // here while debugging; remove once the path is validated.
      phoneNumber: user.phoneNumber,
    });

    const result = await livekitDispatch().createDispatch(
      roomName,
      'tracking-agent',
      { metadata: JSON.stringify(metadata) },
    );
    console.log('[per-user/dispatch] livekit createDispatch ok', {
      wfRunId,
      dispatchId: result.id,
      agentName: result.agentName,
      room: result.room,
    });
  });

  console.log('[per-user] waiting for voice-result', {
    wfRunId,
    eventId: `tracking-call-result-${wfRunId}`,
    timeout: '5m',
  });
  const { eventData, timeout } = await context.waitForEvent(
    'voice-result',
    `tracking-call-result-${wfRunId}`,
    { timeout: '5m' },
  );

  if (timeout) {
    console.log('[per-user] voice-result TIMED OUT after 5m', { wfRunId });
    return;
  }

  const merged = eventData as TrackingEvent;
  console.log('[per-user] voice-result received', {
    wfRunId,
    completedAt: merged.completedAt ?? null,
    ritualKeys: Object.keys(merged.ritualKpis ?? {}),
  });

  if (allRitualsComplete(merged)) {
    console.log('[per-user] voice fully covered all rituals — done', { wfRunId });
    return;
  }

  console.log(
    '[per-user] voice partial; would enter SMS path (Phase 4) for remaining rituals',
    { wfRunId, eventDocId },
  );
});
