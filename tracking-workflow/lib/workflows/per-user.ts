import { createWorkflow } from '@upstash/workflow/nextjs';
import { FieldValue } from 'firebase-admin/firestore';
import { computeRemaining, runChatTurn } from '@/lib/chat-agent';
import { db } from '@/lib/firestore';
import {
  linkKindFor,
  linkMessageForLanguage,
  openerForLanguage,
  type Language,
} from '@/lib/i18n';
import { decideLink } from '@/lib/links';
import { livekitDispatch } from '@/lib/livekit';
import { sendSms } from '@/lib/telnyx';
import {
  allRitualsComplete,
  mergeFinal,
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
  // Optional: short, conversational name per ritual ("morning meditation",
  // "drinking less"). Sourced from Gemini's parse of the Google Doc by
  // cloud-functions/registerNewRitual. May be missing on rituals that
  // pre-date the cloud-functions Phase 7 deploy — fall back to
  // `ritualLabels[googleDocId]` (the verbatim doc title) in that case.
  behaviorLabels?: Record<string, string>;
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
      // Soft-skip rather than throw. A `rituals` row whose `userID` has
      // no corresponding `users/{userID}` doc is almost always seed/test
      // data (e.g. early hand-crafted ritual entries from before
      // cloud-functions/registerNewRitual started writing the canonical
      // users doc). Throwing here turned every such row into 3× Upstash
      // retries + a noisy fail in the dashboard. Returning null lets
      // the run exit cleanly; the dashboard shows the run as Completed
      // with the warning visible in logs.
      console.warn('[per-user/load-user] users doc missing — skipping run', {
        wfRunId,
        userID,
      });
      return null;
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

  if (!user) return;

  await context.run('dispatch-tracking-call', async () => {
    console.log('[per-user/dispatch] enter', { wfRunId });
    const callbackUrl = process.env.TRACKING_CALLBACK_URL;
    if (!callbackUrl) {
      console.error('[per-user/dispatch] TRACKING_CALLBACK_URL not set', { wfRunId });
      throw new Error('TRACKING_CALLBACK_URL is not set');
    }

    // Build the rituals array with both the verbatim Google Doc title
    // (`label`, traceability) and the short conversational name
    // (`behaviorLabel`, what the agent says aloud). Falls back to label
    // when behaviorLabels is missing (older rituals registered before
    // cloud-functions/registerNewRitual started populating the field).
    const rituals = Object.entries(user.ritualLabels).map(
      ([googleDocId, label]) => ({
        googleDocId,
        label,
        behaviorLabel: user.behaviorLabels?.[googleDocId] ?? label,
      }),
    );

    const roomName = `tracking-${wfRunId}`;
    // voice_id intentionally omitted — the tracking-agent hardcodes its
    // voice by language (English-Male / Spanish-Male) rather than
    // consuming user.voiceID, which is owned by narya-agent.
    const metadata = {
      user_id: userID,
      phone_number: user.phoneNumber,
      language: user.language,
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

  // After the wait we have one of three states:
  //   1. timeout=true and no callback fired → fall through to SMS,
  //      treating the merged doc as whatever Firestore currently has
  //      (likely nothing if the agent never reached its shutdown).
  //   2. timeout=false and the doc is fully covered → done; jump to
  //      Phase 5 link delivery.
  //   3. timeout=false and the doc is partial (some rituals/KPIs
  //      still null) → fall through to SMS to fill the gaps.
  let current: TrackingEvent | null;
  if (timeout) {
    console.log('[per-user] voice-result TIMED OUT after 5m', { wfRunId });
    current = await context.run('reload-after-timeout', async () => {
      const snap = await db().collection('trackingEvents').doc(eventDocId).get();
      return snap.exists ? (snap.data() as TrackingEvent) : null;
    });
  } else {
    current = eventData as TrackingEvent;
    console.log('[per-user] voice-result received', {
      wfRunId,
      completedAt: current.completedAt ?? null,
      ritualKeys: Object.keys(current.ritualKpis ?? {}),
    });
  }

  if (current && allRitualsComplete(current)) {
    console.log('[per-user] voice fully covered all rituals — done', { wfRunId });
    await deliverLinkAndFinalize(context, current, user, wfRunId);
    return;
  }

  // ---- Phase 4: SMS chat fallback ----
  // Pre-flight check that Telnyx is configured. If not, we keep what
  // voice gave us, finalize whatever's there, and exit. Better to
  // ship a partial day than to crash the workflow on a missing env.
  const telnyxReady =
    !!process.env.TELNYX_API_KEY &&
    !!process.env.TELNYX_FROM_NUMBER &&
    !!process.env.TELNYX_PUBLIC_KEY;
  if (!telnyxReady) {
    console.warn(
      '[per-user] Telnyx env vars missing, skipping SMS fallback. Finalizing with current state.',
      { wfRunId },
    );
    if (current) await deliverLinkAndFinalize(context, current, user, wfRunId);
    return;
  }

  // Index doc the inbound webhook uses to map a phone number back to
  // the parked workflow run. Set BEFORE sending the opener so the
  // user's first reply has somewhere to land. expiresAt is advisory
  // only — the workflow clears the doc on exit; this field is just a
  // guard against orphaned indexes if the run crashes mid-loop.
  await context.run('record-active-sms-run', async () => {
    await db()
      .collection('smsActiveRuns')
      .doc(user.phoneNumber)
      .set({
        runId: wfRunId,
        userID,
        eventDocId,
        startedAt: FieldValue.serverTimestamp(),
        expiresAt: Date.now() + 90 * 60 * 1000,
      });
  });

  await context.run('send-sms-opener', () =>
    sendSms(user.phoneNumber, openerForLanguage(user.language)),
  );

  // Turn budget: 6 user replies + agent responses. Combined with the
  // 30m per-turn timeout this caps a stalled chat at ~3h before we
  // give up and finalize whatever we have. In practice most users
  // finish in 2-3 turns.
  const TURN_BUDGET = 6;
  for (let i = 0; i < TURN_BUDGET; i++) {
    console.log('[per-user/sms] waiting for reply', {
      wfRunId,
      turn: i,
      eventId: `sms-reply-${wfRunId}`,
    });
    const replyEv = await context.waitForEvent(
      'sms-reply',
      `sms-reply-${wfRunId}`,
      { timeout: '30m' },
    );
    if (replyEv.timeout) {
      console.log('[per-user/sms] reply TIMED OUT after 30m, exiting loop', {
        wfRunId,
        turn: i,
      });
      break;
    }
    const replyData = replyEv.eventData as { from: string; body: string };
    console.log('[per-user/sms] reply received', {
      wfRunId,
      turn: i,
      from: replyData.from,
      bodyPreview: replyData.body.slice(0, 60),
    });

    // Re-derive remaining rituals from the latest doc each turn so a
    // late voice callback (or an out-of-band write) doesn't make us
    // re-ask something already covered.
    const remaining = computeRemaining(
      current,
      user.ritualLabels,
      user.behaviorLabels,
    );
    if (remaining.length === 0) {
      console.log(
        '[per-user/sms] nothing remaining at start of turn — finalizing',
        { wfRunId, turn: i },
      );
      break;
    }

    const turnResult = await context.run(`agent-turn-${i}`, async () => {
      return runChatTurn({
        language: (user.language as Language) ?? 'en',
        remaining,
        userReply: replyData.body,
      });
    });
    console.log('[per-user/sms] agent turn result', {
      wfRunId,
      turn: i,
      kpiUpdates: turnResult.kpiUpdates,
      done: turnResult.done,
      messagePreview: turnResult.message.slice(0, 80),
    });

    // Persist any KPIs the agent extracted this turn. Empty
    // kpiUpdates is fine — agent might have just clarified or asked
    // a follow-up without recording anything new.
    if (Object.keys(turnResult.kpiUpdates).length > 0) {
      current = await context.run(`merge-turn-${i}`, () =>
        mergeFinal(eventDocId, {
          userID,
          date,
          timeZone: user.timeZone,
          channel: 'sms',
          conversationHappened: true,
          ritualKpis: turnResult.kpiUpdates,
          ritualIds: Object.keys(user.ritualLabels),
        }),
      );
    }

    // Send the agent's outbound SMS even if `done`, so the user gets
    // a thank-you. Skip only if the agent emitted an empty body.
    if (turnResult.message.trim().length > 0) {
      await context.run(`send-sms-${i}`, () =>
        sendSms(user.phoneNumber, turnResult.message),
      );
    }

    if (turnResult.done) {
      console.log('[per-user/sms] agent signaled done, exiting loop', {
        wfRunId,
        turn: i,
      });
      break;
    }
    if (current && allRitualsComplete(current)) {
      console.log(
        '[per-user/sms] all rituals complete after merge, exiting loop',
        { wfRunId, turn: i },
      );
      break;
    }
  }

  await context.run('clear-active-sms-run', async () => {
    await db().collection('smsActiveRuns').doc(user.phoneNumber).delete();
  });

  // ---- Phase 5: link delivery + bump lastTrackingEventAt ----
  if (current) await deliverLinkAndFinalize(context, current, user, wfRunId);
});

// Phase 5 finalization, shared between the voice-success branch and
// the SMS-success branch. Sends ONE link (or none) per the precedence
// rule in `decideLink` and bumps users/{userID}.lastTrackingEventAt
// so admin tooling can find users we touched today.
//
// Pulled into its own function to keep the workflow body's branching
// readable. Each Telnyx send + Firestore write is a separate
// context.run so failure of one doesn't roll back the other.
async function deliverLinkAndFinalize(
  context: Parameters<Parameters<typeof createWorkflow<PerUserPayload, void>>[0]>[0],
  doc: TrackingEvent,
  user: UserDoc,
  wfRunId: string,
): Promise<void> {
  const link = decideLink(doc.ritualKpis);
  const kind = linkKindFor(doc.ritualKpis);
  console.log('[per-user/finalize] decided link', { wfRunId, link, kind });

  if (link && kind && process.env.TELNYX_API_KEY && process.env.TELNYX_FROM_NUMBER) {
    await context.run('send-link', () =>
      sendSms(
        user.phoneNumber,
        linkMessageForLanguage(user.language, link, kind),
      ),
    );
  }

  await context.run('bump-last-tracking-at', async () => {
    await db()
      .collection('users')
      .doc(user.userID)
      .set(
        { lastTrackingEventAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
  });
}
