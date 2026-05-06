import { createWorkflow } from '@upstash/workflow/nextjs';
import { db } from '@/lib/firestore';
import { perUserWorkflow } from './per-user';

// Root tracking-workflow run. Triggered by the per-tz QStash schedule
// (Phase 7) at 18:00 (round=primary) and 20:00 (round=retry) local. Body
// shape: `{ tz, round }`.
//
// Two responsibilities, both inside `context.run` / `context.invoke`:
// 1. Load active rituals for the timezone, dedup by userID. Activeness
//    is derived from "user has a row in `rituals`" — no separate active
//    flag (per context-for-code-agent.md's fan-out rationale).
// 2. Fan out one per-user run per unique user via `context.invoke`.
//    Concurrency is capped via a shared `flowControl.key` so the
//    primary + retry rounds across all timezones share one budget.
//
// The 20:00 retry round is intentionally identical to 18:00 — the
// per-user workflow's own idempotency check (allRitualsComplete →
// early-exit) is what makes the retry round skip already-covered users.
// Keeping retry-vs-primary out of this layer means the only thing that
// changes is the body's `round` label, which downstream code logs but
// otherwise ignores.

export interface RootPayload {
  tz: string;
  round: 'primary' | 'retry';
}

interface RitualDoc {
  userID: string;
  timeZone: string;
}

// Shared flowControl key for ALL per-user invocations across every root
// run (every timezone, both rounds). 5 concurrent calls keeps us well
// under Telnyx's per-account SIP/SMS rate limits and inside LiveKit
// Cloud's free-tier concurrent-room ceiling. Bump after a week of
// production data confirms there's headroom.
const PER_USER_FLOW_CONTROL_KEY = 'tracking-per-user';
const PER_USER_PARALLELISM = 5;

export const rootWorkflow = createWorkflow<RootPayload, void>(async (context) => {
  const { tz, round } = context.requestPayload;
  const wfRunId = context.workflowRunId;
  console.log('[root] invoke', { wfRunId, tz, round });

  const userIDs = await context.run('load-users-for-tz', async () => {
    console.log('[root/load-users-for-tz] enter', { wfRunId, tz });
    const snap = await db()
      .collection('rituals')
      .where('timeZone', '==', tz)
      .get();
    const seen = new Set<string>();
    for (const d of snap.docs) {
      const data = d.data() as RitualDoc;
      if (data.userID) seen.add(data.userID);
    }
    const ids = Array.from(seen);
    console.log('[root/load-users-for-tz] result', {
      wfRunId,
      ritualCount: snap.size,
      uniqueUserCount: ids.length,
      userIDs: ids,
    });
    return ids;
  });

  if (userIDs.length === 0) {
    console.log('[root] no users for tz, exiting', { wfRunId, tz });
    return;
  }

  // Promise.all of context.invoke calls runs them concurrently in
  // workflow terms; flowControl above caps actual concurrent execution
  // at PER_USER_PARALLELISM. The root run waits here until every child
  // finishes (or fails); Vercel logs show the full tree because invoke
  // is a first-class step.
  await Promise.all(
    userIDs.map((userID) =>
      context.invoke(`invoke-per-user-${userID}`, {
        workflow: perUserWorkflow,
        body: { userID, runId: wfRunId, tz, round },
        flowControl: {
          key: PER_USER_FLOW_CONTROL_KEY,
          parallelism: PER_USER_PARALLELISM,
        },
      }),
    ),
  );

  console.log('[root] fan-out complete', {
    wfRunId,
    invokedCount: userIDs.length,
  });
});
