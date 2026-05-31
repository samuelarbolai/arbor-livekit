import { describe, expect, it } from 'vitest';
import {
  buildTrackingCallbackBody,
  type TrackingState,
} from './agent';

// The behaviour tests that previously asserted tool-firing
// (recordRitualFulfilled / recordRelapse / recordAnsweredCall /
// markRitualUsedOut) were removed when tracking-agent migrated to the
// converse → extract pattern. KPI population now happens in the
// `extractTrackingKpis` cloud function from the post-call transcript,
// NOT via mid-call tool calls.
//
// The pure-unit tests on buildTrackingCallbackBody stay — they verify
// the wire contract with `tracking-workflow/api/tracking-callback`,
// which is unchanged: silently renaming any field in
// TrackingCallbackBody is still the most plausible regression.

describe('buildTrackingCallbackBody', () => {
  it('preserves the tracking-callback contract for multi-ritual payloads', () => {
    const state: TrackingState = {
      docA: {
        relapse: false,
        ritualFulfilled: true,
        answeredCall: true,
        ritualUsedOut: false,
      },
      docB: {
        relapse: null,
        ritualFulfilled: null,
        answeredCall: null,
        ritualUsedOut: true,
      },
    };

    const body = buildTrackingCallbackBody({
      userID: 'u_123',
      runId: 'wfr_abc',
      conversationHappened: true,
      state,
    });

    expect(body).toEqual({
      userID: 'u_123',
      runId: 'wfr_abc',
      channel: 'voice',
      conversationHappened: true,
      ritualKpis: state,
    });
  });

  it('passes null KPIs through unchanged (partial round / no-answer)', () => {
    const state: TrackingState = {
      docA: {
        relapse: null,
        ritualFulfilled: null,
        answeredCall: null,
        ritualUsedOut: false,
      },
    };

    const body = buildTrackingCallbackBody({
      userID: 'u_123',
      runId: 'wfr_abc',
      conversationHappened: false,
      state,
    });

    expect(body.conversationHappened).toBe(false);
    expect(body.ritualKpis).toEqual({
      docA: {
        relapse: null,
        ritualFulfilled: null,
        answeredCall: null,
        ritualUsedOut: false,
      },
    });
  });
});
