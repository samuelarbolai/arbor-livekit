import type { TrackingEvent } from './tracking-events';

// cal.com URLs hardcoded per the original product spec (verbatim from
// the master file). Bumping these means re-deploying — keep them as
// const exports so any future caller picks up the change in one place.
export const NEW_BELIEF_LINK =
  'https://cal.com/samuel-giraldo-concha-yqvtot/new-belief';
export const OPTIMISATION_LINK =
  'https://cal.com/samuel-giraldo-concha-yqvtot/optimisation';

// Aggregates KPIs across ALL of the user's rituals into a single link
// decision. Precedence: used-out > failure > none. This collapses
// cleanly to the single-ritual semantics: a one-ritual user with
// ritualUsedOut=true gets new-belief, with any failure gets
// optimisation, all-green gets nothing. Multi-ritual users get
// exactly ONE link per day regardless of how many rituals match
// (if they have one used-out + one failing, used-out wins — the
// failing ritual will be re-asked tomorrow; the used-out signal
// needs immediate follow-up).
export function decideLink(
  ritualKpis: TrackingEvent['ritualKpis'],
): string | null {
  const bundles = Object.values(ritualKpis);
  if (bundles.length === 0) return null;

  const anyUsedOut = bundles.some((b) => b.ritualUsedOut === true);
  if (anyUsedOut) return NEW_BELIEF_LINK;

  const anyFailure = bundles.some(
    (b) =>
      b.relapse === true ||
      b.ritualFulfilled === false ||
      b.answeredCall === false,
  );
  return anyFailure ? OPTIMISATION_LINK : null;
}
