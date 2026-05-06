// Sync the QStash Schedules that drive the daily tracking workflow.
// Idempotent: re-running the script updates existing schedules in place
// (matched by stable `scheduleId`), so it's safe to run on every deploy.
//
// Usage:
//   pnpm tsx scripts/sync-schedules.ts [--list] [--delete]
//
// Without flags: creates / updates one schedule per (timezone, round)
// pair, all pointing at /api/tracking-workflow/root with `{ tz, round }`
// in the body.
//   --list   Print every schedule currently registered, then exit.
//   --delete Remove every schedule whose ID begins with `tracking-`.
//            Useful for cleaning up before swapping environments.
//
// Two schedules per timezone — one for the 18:00 primary round, one
// for the 20:00 retry round. The retry round is intentionally identical
// to primary; the per-user workflow's idempotency check skips users
// already covered, so retry only does work for users the primary round
// missed (no-pickup, voicemail, partial answers).
//
// Adding a timezone is a one-line edit to TIMEZONES below + a re-run
// of this script. Do not over-engineer this into a config file.

import { Client } from '@upstash/qstash';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

// Start with one timezone; expand as we onboard users in new ones.
const TIMEZONES: string[] = ['America/Bogota'];

interface RoundSpec {
  name: 'primary' | 'retry';
  // QStash interprets `cron` in the schedule's `timezone` field, so
  // these are local-time values. DST shifts are handled by the IANA
  // database — `0 18` in a DST-observing tz fires at 18:00 local on
  // both sides of a shift.
  cron: string;
}

const ROUNDS: RoundSpec[] = [
  { name: 'primary', cron: '0 18 * * *' }, // 18:00 local
  { name: 'retry', cron: '0 20 * * *' }, //   20:00 local
];

const DEFAULT_BASE_URL = 'https://samwise-tracking.vercel.app';

const token = process.env.QSTASH_TOKEN;
if (!token) {
  console.error('QSTASH_TOKEN must be set in .env.local');
  process.exit(1);
}

const target = process.env.TARGET_URL ?? DEFAULT_BASE_URL;
const baseUrl = target.startsWith('http') ? target : `https://${target}`;
const destination = `${baseUrl}/api/tracking-workflow/root`;

const client = new Client({ token });

function scheduleIdFor(tz: string, round: RoundSpec['name']): string {
  // tz contains '/'; QStash schedule IDs accept `-` and alphanumerics.
  // Lowercase + replace non-word chars with '-' keeps it human-readable
  // (e.g. tracking-primary-america-bogota).
  return `tracking-${round}-${tz.toLowerCase().replace(/\W/g, '-')}`;
}

async function listAll() {
  const all = await client.schedules.list();
  const ours = all.filter((s) => s.scheduleId.startsWith('tracking-'));
  console.log(`Found ${ours.length} tracking-* schedules of ${all.length} total:`);
  for (const s of ours) {
    console.log(
      `  ${s.scheduleId.padEnd(40)}  ${s.cron}  tz=${s.scheduleId.split('-').slice(2).join('/')}  → ${s.destination}`,
    );
  }
}

async function deleteAll() {
  const all = await client.schedules.list();
  const ours = all.filter((s) => s.scheduleId.startsWith('tracking-'));
  console.log(`Deleting ${ours.length} tracking-* schedules...`);
  for (const s of ours) {
    await client.schedules.delete(s.scheduleId);
    console.log(`  deleted ${s.scheduleId}`);
  }
}

async function syncAll() {
  console.log(`Syncing schedules → ${destination}`);
  for (const tz of TIMEZONES) {
    for (const round of ROUNDS) {
      const scheduleId = scheduleIdFor(tz, round.name);
      // QStash 2.10.1's SDK exposes only `cron` (no timezone field).
      // Per the QStash REST docs, the canonical way to bind a cron to
      // an IANA timezone is the `CRON_TZ=<tz> <cron>` prefix syntax —
      // the platform parses this and interprets the cron in that tz
      // (DST-aware via the IANA database).
      const cronWithTz = `CRON_TZ=${tz} ${round.cron}`;
      await client.schedules.create({
        destination,
        cron: cronWithTz,
        scheduleId,
        body: JSON.stringify({ tz, round: round.name }),
      });
      console.log(
        `  ${scheduleId.padEnd(40)}  ${cronWithTz}  body={tz, round:'${round.name}'}`,
      );
    }
  }
  console.log(`Done. ${TIMEZONES.length * ROUNDS.length} schedule(s) synced.`);
}

async function main() {
  const flag = process.argv[2];
  if (flag === '--list') {
    await listAll();
    return;
  }
  if (flag === '--delete') {
    await deleteAll();
    return;
  }
  await syncAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
