import { AgentDispatchClient } from 'livekit-server-sdk';

let client: AgentDispatchClient | null = null;

export function livekitDispatch(): AgentDispatchClient {
  if (client) return client;
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    throw new Error(
      'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set',
    );
  }
  client = new AgentDispatchClient(url, key, secret);
  return client;
}
