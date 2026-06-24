// DemoCallAgent — autonomous Demo Call voice agent (design C: one authored
// flow prompt, no live Doc/teleprompter).
//
// Tools are ALL write-only side-effects (the agent never calls a tool to read —
// everything it needs is in its prompt + the <call-so-far> memory block):
//   - setVariables  commit captured values (user-visible ones go to the screen)
//   - showVisual    switch the prospect's on-screen story visual
//   - endCall       end the call; the worker runs the converse→extract submit
//
// Long-call memory (#6): the agent never carries the full ~70-min transcript.
// onUserTurnCompleted keeps the context bounded — the static prompt + a fresh
// <call-so-far> recap (the durable memory: prefill + everything captured) + the
// last N conversation turns. Older verbatim turns are dropped; their substance
// lives in the captured variables. The worker logs the FULL transcript
// separately for the end-of-call extractor.
import { type JobContext, llm, voice } from '@livekit/agents';
import { TransformStream, type ReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { type DemoCallMeta } from '../../types/metadata';
import { STORY_STAGES, type StoryStage } from './broadcast';
import { CALL_STATE_SENTINEL, CURRENT_PHASE_SENTINEL, DEMO_PHASES} from './prompts/demo-call-prompt';
import { DEMO_CAPTURE_VAR_NAMES } from './variables';

// How many recent conversation messages to keep in the working context. The
// <call-so-far> recap carries everything important from before the window, so
// this only needs to hold the immediate back-and-forth. Tune from real calls.
const MAX_HISTORY_MESSAGES = 30;

// Same TTS-safety stripper as the call/onboarding flows — Cartesia would
// pronounce a literal "(pausa)" or "[breath]"; the prompt forbids them, this
// is the belt-and-suspenders backstop.
const STAGE_DIRECTION = /[([*][^)\]*\n]{0,40}[)\]*]/g;
function stripStageDirections(): TransformStream<string, string> {
  let buffer = '';
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lastOpen = Math.max(buffer.lastIndexOf('('), buffer.lastIndexOf('['));
      if (lastOpen === -1 || /[)\]]/.test(buffer.slice(lastOpen))) {
        controller.enqueue(buffer.replace(STAGE_DIRECTION, ''));
        buffer = '';
        return;
      }
      const head = buffer.slice(0, lastOpen).replace(STAGE_DIRECTION, '');
      if (head) controller.enqueue(head);
      buffer = buffer.slice(lastOpen);
      if (buffer.length > 200) {
        controller.enqueue(buffer);
        buffer = '';
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(buffer.replace(STAGE_DIRECTION, ''));
    },
  });
}

const SetVariablesArgsSchema = z.object({
  updates: z
    .array(
      z.object({
        name: z.enum(DEMO_CAPTURE_VAR_NAMES as unknown as [string, ...string[]]),
        value: z.string(),
      }),
    )
    .describe(
      'Captured values to commit, each {name, value}. Only from what the prospect actually said; never invent. Write tidily, in their own words where it matters. The user-visible ones show on the prospect screen. fit_state, grado_de_identificacion, biologic_symbolic_analogy are your judgments.',
    ),
});
const ShowVisualArgsSchema = z.object({
  stage: z.enum(STORY_STAGES as unknown as [StoryStage, ...StoryStage[]]),
});
const EndCallArgsSchema = z.object({});

const UpdateCallPhaseArgsSchema = z.object({
  phase: z.enum(DEMO_PHASES as unknown as [string, ...string[]]),
});

export type DemoCallAgentCallbacks = {
  /** Apply captured updates; returns the names actually committed. The worker
   *  updates state and broadcasts the user-visible ones to the screen. */
  onSetVars: (updates: Array<{ name: string; value: string }>) => Promise<string[]>;
  onShowVisual: (stage: StoryStage) => void;
  onEndCall: () => void;
    /** Advance the call to a new phase. The worker updates state; the next turn's
   *  <current-phase> block reflects it. */
  onUpdatePhase: (phase: string) => void;
};

export class DemoCallAgent extends voice.Agent {
  // Returns the current <call-so-far> recap content (from worker state), used to
  // refresh the memory block each turn. Captured at construction.
  private readonly getCallStateRecap: () => string;
  private readonly getCurrentPhaseBlock: () => string;

  constructor(
    _meta: DemoCallMeta,
    _ctx: JobContext,
    bakedInstructions: string,
    chatCtx: llm.ChatContext,
    callbacks: DemoCallAgentCallbacks,
    getCallStateRecap: () => string,
    getCurrentPhaseBlock: () => string, 
  ) {
    const { onSetVars, onShowVisual, onEndCall, onUpdatePhase } = callbacks;
    let endCalled = false;

    super({
      chatCtx,
      instructions: bakedInstructions,
      tools: {
        setVariables: llm.tool({
          description:
            "Commit captured values to your notes. The user-visible ones appear on the prospect's screen. Call it the moment you have a value; only from what they actually said.",
          parameters: SetVariablesArgsSchema,
          execute: async ({ updates }) => {
            const committed = await onSetVars(updates ?? []);
            return { committed };
          },
        }),

        updateCallPhase: llm.tool({
          description:
            'Advance to the NEXT phase, in order, the moment the current phase\'s goal is met. Pass the next phase id (e.g. "Phase 1.5"). Never skip, reorder, or repeat a finished phase. After calling, deliver that next phase\'s opening beat in the same turn.',
          parameters: UpdateCallPhaseArgsSchema,
          execute: async ({ phase }) => {
            onUpdatePhase(phase);
            return { ok: true, phase };
          },
        }),

        showVisual: llm.tool({
          description:
            'Change the visual the prospect sees. doc at Phase 5a; in Phase 9 walk doc → promise → loop → mechanism → experience; "hidden" clears it.',
          parameters: ShowVisualArgsSchema,
          execute: async ({ stage }) => {
            onShowVisual(stage);
            return { ok: true };
          },
        }),

        endCall: llm.tool({
          description:
            'End the call. You MUST speak your closing line BEFORE calling this. Takes no arguments.',
          parameters: EndCallArgsSchema,
          execute: async () => {
            if (endCalled) return { ok: true };
            endCalled = true;
            try {
              onEndCall();
            } catch {
              // Worker callback failed — still report ok so the model doesn't loop.
            }
            return { ok: true };
          },
        }),
      },
    });

    this.getCallStateRecap = getCallStateRecap;
    this.getCurrentPhaseBlock = getCurrentPhaseBlock;
  }

  // Speak first (the opener). By default LiveKit Agents waits for the user.
  // Don't await — generateReply returns a SpeechHandle, not a Promise.
  override async onEnter(): Promise<void> {
    this.session.generateReply();
  }

  // Bound the working context every turn (#6): static instructions (sent
  // separately) + a fresh <call-so-far> memory + the last N conversation
  // messages. Drops older verbatim turns AND all past tool items (their effects
  // are done; the recap is the memory), so the context can't grow with the
  // call and no tool-call/output pair is left orphaned.
  override async onUserTurnCompleted(
    chatCtx: llm.ChatContext,
    _newMessage: llm.ChatMessage,
  ): Promise<void> {
    const phaseMsg = llm.ChatMessage.create({
      role: 'system',
      content: `${CURRENT_PHASE_SENTINEL}\n${this.getCurrentPhaseBlock()}`,
    });
    const recap = llm.ChatMessage.create({
      role: 'system',
      content: `${CALL_STATE_SENTINEL}\n${this.getCallStateRecap()}`,
    });
    const recentMessages = chatCtx.items
      .filter(
        (it) => it.type === 'message' && (it.role === 'user' || it.role === 'assistant'),
      )
      .slice(-MAX_HISTORY_MESSAGES);
    chatCtx.items = [phaseMsg, recap, ...recentMessages];
  }

  override async ttsNode(text: ReadableStream<string>, modelSettings: voice.ModelSettings) {
    const stripped = text.pipeThrough(stripStageDirections());
    return voice.Agent.default.ttsNode(this, stripped, modelSettings);
  }
}
