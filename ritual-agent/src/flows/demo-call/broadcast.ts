// Worker-side port of samwise-app/lib/demo-call/broadcast.ts. The autonomous
// demo agent publishes the SAME reliable DataChannel events the human rep's
// /copilot publishes, so the prospect's /meet receiver (samwise-landing) needs
// ZERO changes — it decodes by `type`, not by sender:
//   - demo-call:variable_update { name, value } → fills the prospect's notes panel
//   - demo-call:show_visual      { stage }       → switches the RitualStory visual
// Do NOT rename the `demo-call:*` namespace (the receiver matches on it).
import { type Room } from '@livekit/rtc-node';

export type StoryStage =
  | 'hidden'
  | 'doc'
  | 'promise'
  | 'loop'
  | 'mechanism'
  | 'experience';

// Phase 9 story order (doc → promise → loop → mechanism → experience);
// "hidden" clears the visual. Used to type the showVisual tool's enum.
export const STORY_STAGES: readonly StoryStage[] = [
  'hidden',
  'doc',
  'promise',
  'loop',
  'mechanism',
  'experience',
];

function publish(room: Room, payload: unknown): void {
  try {
    void room.localParticipant?.publishData(
      new TextEncoder().encode(JSON.stringify(payload)),
      { reliable: true },
    );
  } catch {
    // Publish racing shutdown is normal — ignore. The end-of-call extractor
    // still has the value from the transcript / live state.
  }
}

// One user-visible variable's value changed → push it to the prospect's panel.
export function publishVariableUpdate(room: Room, name: string, value: string): void {
  publish(room, { type: 'demo-call:variable_update', name, value });
}

// Switch the story visual on the prospect's screen.
export function publishVisual(room: Room, stage: StoryStage): void {
  publish(room, { type: 'demo-call:show_visual', stage });
}

// Re-emit every non-empty user-visible value. Call when the prospect joins so
// prefilled notes show before the agent edits anything (mirrors the app's
// publishSnapshot).
export function publishSnapshot(
  room: Room,
  state: Record<string, string>,
  userVisibleNames: ReadonlySet<string>,
): void {
  for (const name of userVisibleNames) {
    const value = (state[name] ?? '').trim();
    if (!value) continue;
    publish(room, { type: 'demo-call:variable_update', name, value });
  }
}
