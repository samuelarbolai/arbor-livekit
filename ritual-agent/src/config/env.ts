function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  get LIVEKIT_URL() {
    return requireEnv('LIVEKIT_URL');
  },
  get LIVEKIT_API_KEY() {
    return requireEnv('LIVEKIT_API_KEY');
  },
  get LIVEKIT_API_SECRET() {
    return requireEnv('LIVEKIT_API_SECRET');
  },
  get SIP_OUTBOUND_TRUNK_ID() {
    return requireEnv('SIP_OUTBOUND_TRUNK_ID');
  },
};
