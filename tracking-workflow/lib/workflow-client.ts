import { Client } from '@upstash/workflow';

let client: Client | null = null;

// Lazy-singleton @upstash/workflow Client. Used by the
// /api/tracking-callback and /api/sms-inbound routes to call
// `client.notify(...)` and wake parked workflow runs that are paused on
// `context.waitForEvent`. Both event paths flow through this one
// instance so we don't open a fresh QStash connection per request.
export function workflowClient(): Client {
  if (client) return client;
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN is not set');
  client = new Client({ token });
  return client;
}
