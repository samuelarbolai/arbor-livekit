import { voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachStallRecovery } from './stallRecovery';

const ERROR = voice.AgentSessionEventTypes.Error;
const STATE = voice.AgentSessionEventTypes.AgentStateChanged;

// Minimal emitter standing in for AgentSession. We avoid node:events here on
// purpose: its EventEmitter throws on emit('error') with no listeners, which
// would mask the post-dispose assertion.
class FakeEmitter {
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  on(event: string, fn: (ev: unknown) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }
  off(event: string, fn: (ev: unknown) => void): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, ev: unknown): void {
    this.listeners.get(event)?.forEach((fn) => fn(ev));
  }
}

function makeSession(): {
  session: voice.AgentSession;
  emitError: () => void;
  emitState: (newState: string) => void;
} {
  const emitter = new FakeEmitter();
  return {
    session: emitter as unknown as voice.AgentSession,
    emitError: () =>
      emitter.emit(ERROR, { type: 'error', error: new Error('empty'), source: {} }),
    emitState: (newState: string) =>
      emitter.emit(STATE, { type: 'agent_state_changed', oldState: 'thinking', newState }),
  };
}

describe('attachStallRecovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('recovers after an llm error once the retry burst settles', () => {
    const { session, emitError } = makeSession();
    const onRecover = vi.fn();
    attachStallRecovery(session, { errorGraceMs: 3000, refractoryMs: 8000, onRecover });

    emitError();
    vi.advanceTimersByTime(2999);
    expect(onRecover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledWith('llm_error');
  });

  it('debounces a burst of errors into a single recovery', () => {
    const { session, emitError } = makeSession();
    const onRecover = vi.fn();
    attachStallRecovery(session, { errorGraceMs: 3000, refractoryMs: 8000, onRecover });

    emitError();
    vi.advanceTimersByTime(2000);
    emitError(); // re-arms the grace timer
    vi.advanceTimersByTime(2000); // only 2s since the last error (< 3s)
    expect(onRecover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // 3s since the last error
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('does not recover if the agent resumes speaking before the grace window', () => {
    const { session, emitError, emitState } = makeSession();
    const onRecover = vi.fn();
    attachStallRecovery(session, { errorGraceMs: 3000, onRecover });

    emitError();
    vi.advanceTimersByTime(1000);
    emitState('speaking'); // a retry succeeded — healthy again
    vi.advanceTimersByTime(5000);
    expect(onRecover).not.toHaveBeenCalled();
  });

  it('fires the stall backstop when stuck outside listening/speaking', () => {
    const { session, emitState } = makeSession();
    const onRecover = vi.fn();
    attachStallRecovery(session, { stallMs: 12000, refractoryMs: 8000, onRecover });

    emitState('thinking');
    vi.advanceTimersByTime(11999);
    expect(onRecover).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledWith('stall');
  });

  it('cancels the stall backstop when the agent returns to listening', () => {
    const { session, emitState } = makeSession();
    const onRecover = vi.fn();
    attachStallRecovery(session, { stallMs: 12000, onRecover });

    emitState('thinking');
    vi.advanceTimersByTime(5000);
    emitState('listening');
    vi.advanceTimersByTime(20000);
    expect(onRecover).not.toHaveBeenCalled();
  });

  it('respects the refractory window across triggers', () => {
    const { session, emitError } = makeSession();
    const onRecover = vi.fn();
    attachStallRecovery(session, { errorGraceMs: 3000, refractoryMs: 8000, onRecover });

    emitError();
    vi.advanceTimersByTime(3000);
    expect(onRecover).toHaveBeenCalledTimes(1);

    emitError(); // within refractory → suppressed
    vi.advanceTimersByTime(3000);
    expect(onRecover).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8000); // refractory elapses
    emitError();
    vi.advanceTimersByTime(3000);
    expect(onRecover).toHaveBeenCalledTimes(2);
  });

  it('stops reacting after cleanup', () => {
    const { session, emitError } = makeSession();
    const onRecover = vi.fn();
    const dispose = attachStallRecovery(session, { errorGraceMs: 3000, onRecover });

    dispose();
    emitError();
    vi.advanceTimersByTime(10000);
    expect(onRecover).not.toHaveBeenCalled();
  });
});
