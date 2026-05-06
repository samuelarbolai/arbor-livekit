// Trigger the root tracking-workflow fan-out for one timezone end-to-end
// against the deployed Vercel app. Use this for manual integration
// testing of Phase 6 (per-tz fan-out) before the QStash Schedule
// (Phase 7) is wired up — same payload shape the schedule will send.
//
// Usage:
//   pnpm tsx scripts/trigger-root.ts [tz] [round]
//
// Both positional args are optional. tz defaults to America/Bogota
// (where the test user lives); round defaults to 'primary'.
//
// What this does: publishes a workflow trigger to the root URL via
// QStash. The root workflow loads `rituals` for the timezone, dedups
// by userID, and `context.invoke`s perUserWorkflow for each unique
// user under a shared flowControl key (parallelism: 5). The Upstash
// Workflow dashboard will show one parent run + N child runs.

import { Client } from '@upstash/workflow';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const DEFAULT_TZ = 'America/Bogota';
const DEFAULT_BASE_URL = 'https://samwise-tracking.vercel.app';

const [, , tzArg, roundArg] = process.argv;
const tz = tzArg ?? DEFAULT_TZ;
const round = (roundArg ?? 'primary') as 'primary' | 'retry';

const token = process.env.QSTASH_TOKEN;
if (!token) {
  console.error('QSTASH_TOKEN must be set in .env.local');
  process.exit(1);
}

const target = process.env.TARGET_URL ?? DEFAULT_BASE_URL;
const baseUrl = target.startsWith('http') ? target : `https://${target}`;
const url = `${baseUrl}/api/tracking-workflow/root`;

const client = new Client({ token });

async function main() {
  const { workflowRunId } = await client.trigger({
    url,
    body: { tz, round },
  });

  console.log(`Triggered ROOT workflow for tz=${tz} (${round})`);
  console.log(`workflowRunId: ${workflowRunId}`);
  console.log(`Logs: vercel logs ${baseUrl} --follow`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
