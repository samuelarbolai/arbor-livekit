import { initializeLogger, voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_MODEL,
  Agent,
  buildTrackingCallbackBody,
  freshKpiBundle,
  type RitualEntry,
  type TrackingState,
} from './agent';

dotenv.config({ path: '.env.local' });

initializeLogger({ pretty: false, level: 'warn' });

// Phase 6 multi-ritual tests — anchor the tracking-agent's behavior under
// Option C (one call per user, walks through every ritual). Per AGENTS.md,
// these tests drive any future iteration on the prompt: if a test fails,
// adjust the prompt, never adjust the test.
//
// Behavior tests exercise the full conversation against a real LLM via
// LiveKit Inference (uses LIVEKIT_API_KEY from .env.local). They are slow
// (multi-turn LLM) — generous timeouts.
//
// Pure-unit tests on buildTrackingCallbackBody verify the
// `tracking-workflow/api/tracking-callback` contract: silently renaming
// any field is the most plausible regression.

const RITUAL_A: RitualEntry = {
  googleDocId: 'docA',
  label: 'Morning meditation',
};
const RITUAL_B: RitualEntry = {
  googleDocId: 'docB',
  label: 'Evening journaling',
};

function freshState(rituals: RitualEntry[]): TrackingState {
  return Object.fromEntries(rituals.map((r) => [r.googleDocId, freshKpiBundle()]));
}

describe('tracking-agent — single ritual', () => {
  let session: voice.AgentSession;
  let agentLlm: google.LLM;
  let state: TrackingState;
  const rituals = [RITUAL_A];

  beforeEach(async () => {
    agentLlm = new google.LLM({ model: AGENT_MODEL });
    session = new voice.AgentSession({ llm: agentLlm });
    state = freshState(rituals);
    await session.start({
      agent: new Agent({ state, language: 'English', rituals }),
    });
  });

  afterEach(async () => {
    await session?.close();
    await agentLlm?.aclose();
  });

  it(
    'asks the three KPIs in order for the single ritual, recording each',
    { timeout: 120000 },
    async () => {
      await session.run({ userInput: 'Hi' }).wait();

      const r2 = await session
        .run({ userInput: 'Yes, I did fulfill my morning meditation today.' })
        .wait();
      r2.expect.containsFunctionCall({
        name: 'recordRitualFulfilled',
        args: { googleDocId: RITUAL_A.googleDocId, value: true },
      });
      expect(state[RITUAL_A.googleDocId].ritualFulfilled).toBe(true);
      expect(state[RITUAL_A.googleDocId].relapse).toBeNull();
      expect(state[RITUAL_A.googleDocId].answeredCall).toBeNull();

      const r3 = await session
        .run({ userInput: 'No, I did not have a relapse.' })
        .wait();
      r3.expect.containsFunctionCall({
        name: 'recordRelapse',
        args: { googleDocId: RITUAL_A.googleDocId, value: false },
      });
      expect(state[RITUAL_A.googleDocId].relapse).toBe(false);
      expect(state[RITUAL_A.googleDocId].answeredCall).toBeNull();

      const r4 = await session
        .run({ userInput: 'Yes, I answered the morning call.' })
        .wait();
      r4.expect.containsFunctionCall({
        name: 'recordAnsweredCall',
        args: { googleDocId: RITUAL_A.googleDocId, value: true },
      });
      expect(state[RITUAL_A.googleDocId].answeredCall).toBe(true);
      expect(state[RITUAL_A.googleDocId].ritualUsedOut).toBe(false);
    },
  );

  it(
    'used-out exception fires markRitualUsedOut for the single ritual and ends',
    { timeout: 120000 },
    async () => {
      await session.run({ userInput: 'Hi' }).wait();
      const r = await session
        .run({
          userInput:
            "Honestly I do not need this one anymore. I solved that problem.",
        })
        .wait();

      r.expect.containsFunctionCall({
        name: 'markRitualUsedOut',
        args: { googleDocId: RITUAL_A.googleDocId },
      });
      expect(state[RITUAL_A.googleDocId].ritualUsedOut).toBe(true);
      // KPIs may be null — once used-out fires for the only ritual, the
      // call wraps up and we should NOT have collected the others.
      expect(state[RITUAL_A.googleDocId].relapse).toBeNull();
      expect(state[RITUAL_A.googleDocId].ritualFulfilled).toBeNull();
      expect(state[RITUAL_A.googleDocId].answeredCall).toBeNull();
    },
  );

  it(
    'single-ritual used-out terminates: no further KPI tools fire even if user keeps talking',
    { timeout: 120000 },
    async () => {
      // Field-bug regression test (2026-05-05). After markRitualUsedOut
      // for the only ritual, the deployed agent said goodbye and then
      // followed with "Did you answer the morning call…" — i.e. it kept
      // walking the KPI list. With used-out being the canonical short-
      // circuit, no further KPI tool should fire even if the user stays
      // on the line and says something that LOOKS like a yes/no answer.
      await session.run({ userInput: 'Hi' }).wait();
      const r1 = await session
        .run({
          userInput:
            "Honestly I do not need this one anymore. I solved that problem.",
        })
        .wait();
      r1.expect.containsFunctionCall({
        name: 'markRitualUsedOut',
        args: { googleDocId: RITUAL_A.googleDocId },
      });

      // User keeps talking — yes/no-shaped utterance that COULD be
      // interpreted as a KPI answer. The agent must NOT fire any KPI
      // tool here; the only ritual is already retired. Asserting on
      // state is sufficient because every KPI tool's execute() flips
      // the corresponding bundle field.
      await session.run({ userInput: 'Yes, by the way.' }).wait();
      expect(state[RITUAL_A.googleDocId].ritualFulfilled).toBeNull();
      expect(state[RITUAL_A.googleDocId].relapse).toBeNull();
      expect(state[RITUAL_A.googleDocId].answeredCall).toBeNull();
    },
  );
});

describe('tracking-agent — multi-ritual (two rituals)', () => {
  let session: voice.AgentSession;
  let agentLlm: google.LLM;
  let state: TrackingState;
  const rituals = [RITUAL_A, RITUAL_B];

  beforeEach(async () => {
    agentLlm = new google.LLM({ model: AGENT_MODEL });
    session = new voice.AgentSession({ llm: agentLlm });
    state = freshState(rituals);
    await session.start({
      agent: new Agent({ state, language: 'English', rituals }),
    });
  });

  afterEach(async () => {
    await session?.close();
    await agentLlm?.aclose();
  });

  it(
    'walks both rituals in dispatch order, asking three KPIs per ritual',
    { timeout: 240000 },
    async () => {
      await session.run({ userInput: 'Hi' }).wait();

      // Ritual A: three KPIs.
      await session
        .run({ userInput: 'Yes, I did the morning meditation.' })
        .wait();
      await session.run({ userInput: 'No, no relapse on that one.' }).wait();
      await session
        .run({ userInput: 'Yes, I answered the morning call for it.' })
        .wait();

      expect(state[RITUAL_A.googleDocId].ritualFulfilled).toBe(true);
      expect(state[RITUAL_A.googleDocId].relapse).toBe(false);
      expect(state[RITUAL_A.googleDocId].answeredCall).toBe(true);
      // Ritual B should still be untouched.
      expect(state[RITUAL_B.googleDocId].ritualFulfilled).toBeNull();
      expect(state[RITUAL_B.googleDocId].relapse).toBeNull();
      expect(state[RITUAL_B.googleDocId].answeredCall).toBeNull();

      // Ritual B: three KPIs.
      await session
        .run({ userInput: 'Yes, I did the evening journaling too.' })
        .wait();
      await session.run({ userInput: 'No relapse on that either.' }).wait();
      await session
        .run({ userInput: 'Yes, I answered the morning call for journaling.' })
        .wait();

      expect(state[RITUAL_B.googleDocId].ritualFulfilled).toBe(true);
      expect(state[RITUAL_B.googleDocId].relapse).toBe(false);
      expect(state[RITUAL_B.googleDocId].answeredCall).toBe(true);
    },
  );

  it(
    'per-ritual used-out moves on to next ritual, does not terminate the call',
    { timeout: 240000 },
    async () => {
      await session.run({ userInput: 'Hi' }).wait();

      // User immediately declares they have outgrown ritual A.
      const r2 = await session
        .run({
          userInput:
            "About the morning meditation — I do not need this one anymore. I solved it.",
        })
        .wait();
      r2.expect.containsFunctionCall({
        name: 'markRitualUsedOut',
        args: { googleDocId: RITUAL_A.googleDocId },
      });
      expect(state[RITUAL_A.googleDocId].ritualUsedOut).toBe(true);

      // The agent should now move on to ritual B and ask its first KPI.
      // Drive ritual B's three KPIs to confirm the call did NOT terminate.
      await session
        .run({ userInput: 'Yes, I did the evening journaling.' })
        .wait();
      await session.run({ userInput: 'No, no relapse on journaling.' }).wait();
      await session
        .run({ userInput: 'Yes, I answered the morning call for journaling.' })
        .wait();

      expect(state[RITUAL_B.googleDocId].ritualFulfilled).toBe(true);
      expect(state[RITUAL_B.googleDocId].relapse).toBe(false);
      expect(state[RITUAL_B.googleDocId].answeredCall).toBe(true);
      expect(state[RITUAL_B.googleDocId].ritualUsedOut).toBe(false);
    },
  );

  it(
    'userTurnCount listener increments on user messages',
    { timeout: 60000 },
    async () => {
      // Mirrors the listener wiring in main.ts so a regression in the
      // discriminator (e.g. forgetting the `'role' in ev.item` narrow,
      // or the wrong event enum) is caught here.
      let userTurnCount = 0;
      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
        if ('role' in ev.item && ev.item.role === 'user') userTurnCount++;
      });

      await session.run({ userInput: 'Hi' }).wait();
      expect(userTurnCount).toBe(1);

      await session.run({ userInput: 'Yes, ritual done.' }).wait();
      expect(userTurnCount).toBe(2);
    },
  );
});

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
