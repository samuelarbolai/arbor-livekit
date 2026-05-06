// Trigger a single per-user tracking run end-to-end against the deployed
// Vercel app. Use this for manual integration testing of the voice path
// before Phase 6 (the QStash Schedule + root fan-out) is wired up.
//
// Usage:
//   pnpm tsx scripts/trigger-per-user.ts [userID] [tz] [round]
//
// All three positional args are optional and fall back to defaults
// targeting the current production deployment. Override on the command
// line when testing a different user / timezone.
//
// Defaults below are wired for the current test user (Samuel, Bogota).
// Edit the constants if your test target changes — keeping defaults in
// the script (vs flags) makes a re-run a single short command.
//
// Requires QSTASH_TOKEN in .env.local (auto-loaded). The token is the
// same one Vercel's Upstash integration sets.
//
// What this does: publishes a workflow trigger via QStash. QStash then
// POSTs the per-user route with the right signing headers and the
// workflow engine takes over (idempotency check → load user → dispatch
// tracking-call → waitForEvent on the agent's shutdown POST).

import { Client } from '@upstash/workflow';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const DEFAULT_USER_ID = 'pZX1S3FySfgre88oHxHu09JqMGz1';
const DEFAULT_TZ = 'America/Bogota';
const DEFAULT_BASE_URL = 'https://samwise-tracking.vercel.app';

const [, , userIDArg, tzArg, roundArg] = process.argv;
const userID = userIDArg ?? DEFAULT_USER_ID;
const tz = tzArg ?? DEFAULT_TZ;
const round = (roundArg ?? 'primary') as 'primary' | 'retry';

const token = process.env.QSTASH_TOKEN;
if (!token) {
  console.error('QSTASH_TOKEN must be set in .env.local');
  process.exit(1);
}

const target = process.env.TARGET_URL ?? DEFAULT_BASE_URL;
const baseUrl = target.startsWith('http') ? target : `https://${target}`;
const url = `${baseUrl}/api/tracking-workflow/per-user`;

const client = new Client({ token });

// Wrapped in main() because the project's package.json doesn't declare
// "type": "module", so tsx transforms scripts as CJS — which forbids
// top-level await. Adding "type": "module" globally would risk
// disrupting Next.js's route handling, so the IIFE is the safer scope.
async function main() {
  const { workflowRunId } = await client.trigger({
    url,
    body: {
      userID,
      runId: `manual-${Date.now()}`,
      tz,
      round,
    },
  });

  console.log(`Triggered workflow run for ${userID} (${tz}, ${round})`);
  console.log(`workflowRunId: ${workflowRunId}`);
  console.log(`Logs: vercel logs ${baseUrl} --follow`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
