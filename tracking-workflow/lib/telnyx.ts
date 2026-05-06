import Telnyx from 'telnyx';
import { TelnyxWebhook } from 'telnyx/lib/webhooks';

// Lazy-singleton Telnyx client + webhook verifier. Two env vars:
//   TELNYX_API_KEY    — Bearer token for outbound /messages/send
//   TELNYX_PUBLIC_KEY — Base64 Ed25519 key from Mission Control →
//                       Messaging → Messaging Profiles → <profile> →
//                       "Public key" (used by the SDK's webhooks.verify
//                       to validate inbound POSTs to /api/sms-inbound)
//
// Plus one config:
//   TELNYX_FROM_NUMBER — the phone number on this profile, in E.164.
//                        We send SMS from this single number; the
//                        Telnyx Messaging Profile's outbound settings
//                        determine routing.

let telnyxClient: Telnyx | null = null;
let webhookVerifier: TelnyxWebhook | null = null;

function client(): Telnyx {
  if (telnyxClient) return telnyxClient;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY is not set');
  telnyxClient = new Telnyx({ apiKey });
  return telnyxClient;
}

function verifier(): TelnyxWebhook {
  if (webhookVerifier) return webhookVerifier;
  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKey) throw new Error('TELNYX_PUBLIC_KEY is not set');
  webhookVerifier = new TelnyxWebhook(publicKey);
  return webhookVerifier;
}

// Send an outbound SMS. Phone-number sender (no alpha sender) so users
// can reply — the Phase 4 chat loop relies on two-way SMS. `from` is
// pinned to TELNYX_FROM_NUMBER; we don't accept it as a parameter
// because there's exactly one number on this profile.
export async function sendSms(to: string, text: string): Promise<void> {
  const from = process.env.TELNYX_FROM_NUMBER;
  if (!from) throw new Error('TELNYX_FROM_NUMBER is not set');
  await client().messages.send({ to, from, text });
}

// Verify a Telnyx webhook against TELNYX_PUBLIC_KEY using Ed25519. The
// payload must be the raw request body string (no JSON.parse — the
// signature is over the unparsed bytes); headers carry the signature
// and timestamp the SDK consumes. Throws TelnyxWebhookVerificationError
// on mismatch; caller should respond 401 in that case.
export async function verifyInboundSignature(
  rawBody: string,
  headers: Record<string, string>,
): Promise<void> {
  await verifier().verify(rawBody, headers);
}
