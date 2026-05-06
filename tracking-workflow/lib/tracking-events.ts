import { Timestamp } from 'firebase-admin/firestore';
import { db } from './firestore';

// Canonical type for the `trackingEvents/${userID}_${date}` doc. KPIs are
// keyed per-ritual (Option C); see context-for-code-agent.md for the
// monotonic-merge invariant. Phase 2 introduces the type + the
// `allRitualsComplete` predicate; Phase 3 adds `mergeFinal` (the single
// writer used by both /api/tracking-callback and the SMS finalization
// step) into this same file.

export interface KpiBundle {
  relapse: boolean | null;
  ritualFulfilled: boolean | null;
  answeredCall: boolean | null;
  ritualUsedOut: boolean;
}

export interface TrackingEvent {
  userID: string;
  date: string; // YYYY-MM-DD in the user's timezone.
  timeZone: string;
  ritualKpis: Record<string, KpiBundle>;
  followUpSent: 'optimisation' | 'new-belief' | null;
  attempts: Array<{
    ts: Timestamp;
    channel: 'voice' | 'sms';
    conversationHappened: boolean;
    partial: object;
  }>;
  completedAt: Timestamp | null;
}

// True iff every ritual on the doc is "satisfied" — i.e., all three KPIs
// are non-null OR ritualUsedOut is true. Used-out rituals are
// intentionally treated as complete: the user has retired them, and
// asking the remaining KPIs would be hostile. Used by the per-user
// route's idempotency check and by Phase 3's "voice fully covered,
// skip SMS" branch. Empty `ritualKpis` returns false — a doc with no
// rituals isn't "complete," it's malformed; treat it as not-yet-covered
// so the run proceeds and surfaces the issue.
export function allRitualsComplete(doc: TrackingEvent | null | undefined): boolean {
  if (!doc) return false;
  const bundles = Object.values(doc.ritualKpis);
  if (bundles.length === 0) return false;
  return bundles.every(
    (b) =>
      b.ritualUsedOut === true ||
      (b.relapse !== null && b.ritualFulfilled !== null && b.answeredCall !== null),
  );
}

function freshKpiBundle(): KpiBundle {
  return {
    relapse: null,
    ritualFulfilled: null,
    answeredCall: null,
    ritualUsedOut: false,
  };
}

// Body posted into mergeFinal from BOTH write paths:
//   - /api/tracking-callback (voice agent shutdown POST): channel:'voice'
//   - per-user SMS finalization step (Phase 5):           channel:'sms'
// `ritualKpis` is the partial — keys initialize new ritual entries on
// the doc; values flip null→boolean per the monotonic-merge invariant.
// `ritualIds` is consulted only on first write (fresh doc) to seed the
// shape; later partials reuse what's already there.
export interface MergeFinalInput {
  userID: string;
  date: string;
  timeZone: string;
  channel: 'voice' | 'sms';
  conversationHappened: boolean;
  ritualKpis: Record<string, Partial<KpiBundle>>;
  ritualIds?: string[];
}

// Single writer for trackingEvents/{userID}_{date}. Applies the
// per-(googleDocId, kpiField) monotonic-merge invariant, appends to the
// audit log, and stamps `completedAt` the first moment every ritual is
// fully recorded. Wrapped in a Firestore transaction so concurrent
// writers (voice callback and SMS finalize potentially racing on the
// same doc) cannot stomp each other — read-modify-write would be
// vulnerable, transaction.get + transaction.set is not. See
// context-for-code-agent.md's worked example for the multi-ritual
// case this is designed around.
export async function mergeFinal(
  eventDocId: string,
  partial: MergeFinalInput,
): Promise<TrackingEvent> {
  const ref = db().collection('trackingEvents').doc(eventDocId);
  return await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = (snap.exists ? snap.data() : null) as TrackingEvent | null;

    const seedRitualIds =
      partial.ritualIds ?? Object.keys(partial.ritualKpis);
    const doc: TrackingEvent =
      existing ??
      ({
        userID: partial.userID,
        date: partial.date,
        timeZone: partial.timeZone,
        ritualKpis: Object.fromEntries(
          seedRitualIds.map((id) => [id, freshKpiBundle()]),
        ),
        followUpSent: null,
        attempts: [],
        completedAt: null,
      } satisfies TrackingEvent);

    // Initialize any ritual keys present in the incoming partial that
    // aren't yet on the doc. Lets a late-arriving partial seed a ritual
    // whose first POST happened to omit it.
    for (const id of Object.keys(partial.ritualKpis)) {
      if (!doc.ritualKpis[id]) doc.ritualKpis[id] = freshKpiBundle();
    }

    for (const [id, bundle] of Object.entries(partial.ritualKpis)) {
      const target = doc.ritualKpis[id]!;
      // Only flip null→boolean per (ritual, KPI). Existing booleans are
      // sticky; re-posted values for already-collected fields no-op.
      if (target.relapse === null && bundle.relapse != null) {
        target.relapse = bundle.relapse;
      }
      if (target.ritualFulfilled === null && bundle.ritualFulfilled != null) {
        target.ritualFulfilled = bundle.ritualFulfilled;
      }
      if (target.answeredCall === null && bundle.answeredCall != null) {
        target.answeredCall = bundle.answeredCall;
      }
      // ritualUsedOut: one-way OR. false→true is sticky; true never reverts.
      if (bundle.ritualUsedOut === true) target.ritualUsedOut = true;
    }

    doc.attempts.push({
      ts: Timestamp.now(),
      channel: partial.channel,
      conversationHappened: partial.conversationHappened,
      partial: partial.ritualKpis,
    });

    if (doc.completedAt === null && allRitualsComplete(doc)) {
      doc.completedAt = Timestamp.now();
    }

    tx.set(ref, doc);
    return doc;
  });
}
