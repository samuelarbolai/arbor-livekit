import { NextResponse } from 'next/server';
import { db } from '@/lib/firestore';
import { verifyInboundSignature } from '@/lib/telnyx';
import { workflowClient } from '@/lib/workflow-client';

// Telnyx inbound message webhook. Configured in the Messaging Profile
// → Inbound settings → Webhook URL. Telnyx POSTs every inbound SMS
// here; we verify the Ed25519 signature, look up the active workflow
// run for this phone number, and notify it so its `waitForEvent`
// resolves.
//
// v1 only handles replies that arrive WHILE a tracking run is parked
// at the SMS chat step — i.e. the phone number has a matching doc in
// `smsActiveRuns`. Proactive-inbound (a user texting cold without an
// active run) is deferred to v2. We log + return 200 in that case so
// Telnyx doesn't keep retrying.

interface TelnyxInboundPayload {
  data?: {
    event_type?: string;
    payload?: {
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string }>;
      text?: string;
    };
  };
}

interface SmsActiveRunDoc {
  runId: string;
  userID: string;
  eventDocId: string;
  expiresAt?: number;
}

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  // Telnyx signs the webhook with Ed25519. Reject if the signature
  // doesn't match — anyone could be POSTing here otherwise.
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  try {
    await verifyInboundSignature(rawBody, headers);
  } catch (err) {
    console.warn('[sms-inbound] signature verification failed', {
      err: (err as Error).message,
    });
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // Parse after verifying — signature is over the raw bytes.
  let body: TelnyxInboundPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Telnyx fires several event_types on this webhook. We only care
  // about inbound user-typed messages. Filter early so delivery
  // receipts and other noise don't try to drive the chat agent.
  const eventType = body.data?.event_type;
  if (eventType !== 'message.received') {
    console.log('[sms-inbound] ignoring event_type', { eventType });
    return NextResponse.json({ ok: true });
  }

  const fromNumber = body.data?.payload?.from?.phone_number;
  const text = body.data?.payload?.text;
  if (!fromNumber || !text) {
    console.warn('[sms-inbound] missing from/text', { fromNumber, hasText: !!text });
    return NextResponse.json({ ok: true });
  }

  // Look up the parked run for this phone number. If absent, this is
  // either a proactive-inbound (v2 territory) or a stale reply after
  // the run already exited; log and drop.
  const activeSnap = await db()
    .collection('smsActiveRuns')
    .doc(fromNumber)
    .get();
  if (!activeSnap.exists) {
    console.log('[sms-inbound] no active run for phone (proactive-inbound or stale)', {
      fromNumber,
    });
    return NextResponse.json({ ok: true });
  }
  const active = activeSnap.data() as SmsActiveRunDoc;

  console.log('[sms-inbound] notifying parked workflow', {
    fromNumber,
    runId: active.runId,
    bodyPreview: text.slice(0, 60),
  });

  await workflowClient().notify({
    eventId: `sms-reply-${active.runId}`,
    eventData: { from: fromNumber, body: text },
  });

  return NextResponse.json({ ok: true });
}
