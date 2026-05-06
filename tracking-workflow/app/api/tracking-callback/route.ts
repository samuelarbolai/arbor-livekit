import { NextResponse } from 'next/server';
import { db } from '@/lib/firestore';
import { mergeFinal, type KpiBundle } from '@/lib/tracking-events';
import { workflowClient } from '@/lib/workflow-client';

// Receiver for the LiveKit tracking-agent's shutdown POST. The agent
// posts this exactly once at session shutdown (every exit path: natural
// end, hangup, voicemail, error). The body is the per-ritual ritualKpis
// map; this route applies the monotonic merge and wakes the parked
// workflow run via client.notify.
//
// This is a plain Next.js route (not a workflow `serve()`) — it's a
// one-shot HTTP endpoint, not a long-running orchestration.
//
// Idempotent on duplicate POSTs:
//   1. mergeFinal is monotonic (already-collected KPIs are sticky).
//   2. client.notify on an already-resumed workflow is a no-op (per the
//      upstash-workflow-js skill's wait-for-event pitfalls).

interface CallbackBody {
  userID: string;
  runId: string;
  channel: 'voice';
  conversationHappened: boolean;
  ritualKpis: Record<string, KpiBundle>;
}

export async function POST(req: Request) {
  console.log('[tracking-callback] hit');

  let body: CallbackBody;
  try {
    body = (await req.json()) as CallbackBody;
  } catch (err) {
    console.error('[tracking-callback] invalid JSON body', err);
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  console.log('[tracking-callback] body', {
    userID: body.userID,
    runId: body.runId,
    channel: body.channel,
    conversationHappened: body.conversationHappened,
    ritualIds: Object.keys(body.ritualKpis ?? {}),
  });

  if (
    !body.userID ||
    !body.runId ||
    body.channel !== 'voice' ||
    !body.ritualKpis
  ) {
    console.error('[tracking-callback] malformed body', { body });
    return NextResponse.json({ error: 'Malformed body' }, { status: 400 });
  }

  const userSnap = await db().collection('users').doc(body.userID).get();
  if (!userSnap.exists) {
    console.error('[tracking-callback] users doc missing', {
      userID: body.userID,
    });
    return NextResponse.json(
      { error: `users/${body.userID} not found` },
      { status: 404 },
    );
  }
  const userData = userSnap.data() as { timeZone?: string };
  const timeZone = userData.timeZone;
  if (!timeZone) {
    console.error('[tracking-callback] users doc missing timeZone', {
      userID: body.userID,
    });
    return NextResponse.json(
      { error: `users/${body.userID} missing timeZone` },
      { status: 500 },
    );
  }

  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const eventDocId = `${body.userID}_${date}`;
  console.log('[tracking-callback] computed eventDocId', {
    eventDocId,
    timeZone,
  });

  const merged = await mergeFinal(eventDocId, {
    userID: body.userID,
    date,
    timeZone,
    channel: 'voice',
    conversationHappened: body.conversationHappened,
    ritualKpis: body.ritualKpis,
    ritualIds: Object.keys(body.ritualKpis),
  });
  console.log('[tracking-callback] mergeFinal ok', {
    eventDocId,
    completedAt: merged.completedAt ?? null,
    ritualKeys: Object.keys(merged.ritualKpis ?? {}),
    attemptsCount: merged.attempts?.length ?? 0,
  });

  const eventId = `tracking-call-result-${body.runId}`;
  const notifyRes = await workflowClient().notify({
    eventId,
    eventData: merged,
  });
  console.log('[tracking-callback] notify ok', {
    eventId,
    notifyRes,
  });

  return new NextResponse(null, { status: 204 });
}
