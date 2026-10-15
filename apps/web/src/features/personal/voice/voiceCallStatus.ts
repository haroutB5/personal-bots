/**
 * Where the voice reads the real bot from.
 *
 * One source per thread, registered by whichever chat screens are mounted, and
 * the call reads only the thread it is on. Two rules make this safe (pre-ship
 * review, finding 6):
 *
 * 1. A source that is not the call's thread is never read, so a minimised call
 *    can never read the chat the owner happens to be looking at.
 * 2. When the call's own chat is not mounted, the last answer is kept. It never
 *    becomes `idle`, because "the screen went away" must not look like "the bot
 *    finished its turn" - that would answer a held send early and let the voice
 *    claim work that is still running.
 *
 * @module features/personal/voice/voiceCallStatus
 */
import type { BotStatusPort } from "./voiceCallController";

/** What is known about a bot before anything has been read. */
export const UNKNOWN_BOT_STATUS: BotStatusPort = {
  state: "idle",
  step: null,
  elapsedMs: null,
  latestReply: null,
};

export interface VoiceCallStatusWatch {
  /** A chat screen offers its own bot-status source for one thread. */
  register(threadId: string, source: () => BotStatusPort): () => void;
  /** The bot's state on the call's thread, or the last known answer. */
  read(threadId: string | null): BotStatusPort;
  /** True while a real source for that thread is mounted. */
  hasSource(threadId: string | null): boolean;
  /** Forgets everything (a call ended, or the shell unmounted). */
  reset(): void;
}

export function createVoiceCallStatusWatch(): VoiceCallStatusWatch {
  const sources = new Map<string, () => BotStatusPort>();
  let last: BotStatusPort = UNKNOWN_BOT_STATUS;
  let hasLast = false;

  return {
    register(threadId, source) {
      sources.set(threadId, source);
      return () => {
        if (sources.get(threadId) === source) sources.delete(threadId);
      };
    },
    read(threadId) {
      const source = threadId === null ? undefined : sources.get(threadId);
      if (source !== undefined) {
        try {
          last = source();
          hasLast = true;
          return last;
        } catch {
          // A screen mid-teardown: the last known answer stands.
        }
      }
      // The call's chat is not on screen. The last real answer is what the voice
      // keeps, whatever the rest of the app is showing.
      return hasLast ? last : UNKNOWN_BOT_STATUS;
    },
    hasSource(threadId) {
      return threadId !== null && sources.has(threadId);
    },
    reset() {
      sources.clear();
      last = UNKNOWN_BOT_STATUS;
      hasLast = false;
    },
  };
}

/**
 * True on the tick where the bot really stopped working. The caller feeds in
 * "is it working now" for the CALL's own thread.
 */
export function turnJustEnded(input: {
  readonly wasWorking: boolean;
  readonly working: boolean;
}): boolean {
  return input.wasWorking && !input.working;
}

/**
 * One tick of the watch. `watching` is false when the call's own chat is not
 * mounted, and then the previous answer is held: a screen going away must never
 * be read as the bot finishing (review finding 6).
 */
export function observeCallTurn(input: {
  readonly watching: boolean;
  readonly live: boolean;
  readonly status: BotStatusPort;
  readonly wasWorking: boolean;
}): { readonly working: boolean; readonly ended: boolean } {
  if (!input.watching) return { working: input.wasWorking, ended: false };
  const working = input.live && input.status.state === "working";
  return { working, ended: turnJustEnded({ wasWorking: input.wasWorking, working }) };
}
