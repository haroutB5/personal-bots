/**
 * The review's finding 6: the voice must read the CALL's own chat, and a screen
 * going away must never look like the bot finishing its turn.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { BotStatusPort } from "./voiceCallController";
import { UNKNOWN_BOT_STATUS, createVoiceCallStatusWatch, observeCallTurn } from "./voiceCallStatus";

const status = (patch: Partial<BotStatusPort> = {}): BotStatusPort => ({
  state: "idle",
  step: null,
  elapsedMs: null,
  latestReply: null,
  ...patch,
});

/** One tick of the provider's own watch loop. */
function makeTick(watch: ReturnType<typeof createVoiceCallStatusWatch>, threadId: string) {
  let wasWorking = false;
  return () => {
    const turn = observeCallTurn({
      watching: watch.hasSource(threadId),
      live: true,
      status: watch.read(threadId),
      wasWorking,
    });
    wasWorking = turn.working;
    return turn.ended;
  };
}

describe("createVoiceCallStatusWatch", () => {
  it("reads the call's own thread and nothing else", () => {
    const watch = createVoiceCallStatusWatch();
    watch.register("call-thread", () => status({ state: "working", step: "Deploying" }));
    watch.register("other-thread", () => status({ state: "needs_help", step: "Waiting on you" }));

    expect(watch.read("call-thread")).toEqual({
      state: "working",
      step: "Deploying",
      elapsedMs: null,
      latestReply: null,
    });
    // Even though the other chat is the one on screen.
    expect(watch.read("other-thread").state).toBe("needs_help");
  });

  it("keeps the last real answer when the call's chat unmounts", () => {
    const watch = createVoiceCallStatusWatch();
    const unregister = watch.register("call-thread", () =>
      status({ state: "working", step: "Running the gates" }),
    );
    expect(watch.read("call-thread").state).toBe("working");
    expect(watch.hasSource("call-thread")).toBe(true);

    unregister();
    expect(watch.hasSource("call-thread")).toBe(false);
    // Not idle: the bot is still working, we just stopped looking.
    expect(watch.read("call-thread")).toEqual({
      state: "working",
      step: "Running the gates",
      elapsedMs: null,
      latestReply: null,
    });
  });

  it("never turns a source change into a turn end", () => {
    const watch = createVoiceCallStatusWatch();
    const source = vi.fn(() => status({ state: "working" }));
    const unregister = watch.register("call-thread", source);
    const tick = makeTick(watch, "call-thread");

    expect(tick()).toBe(false);
    // Navigating away: the source is gone, but the bot is not finished.
    unregister();
    expect(tick()).toBe(false);
    expect(tick()).toBe(false);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("still reports the real turn end", () => {
    const watch = createVoiceCallStatusWatch();
    let current = status({ state: "working" });
    watch.register("call-thread", () => current);
    const tick = makeTick(watch, "call-thread");
    expect(tick()).toBe(false);
    current = status({ state: "idle", latestReply: "Done." });
    expect(tick()).toBe(true);
    expect(tick()).toBe(false);
  });

  it("answers with nothing known before anything is registered", () => {
    const watch = createVoiceCallStatusWatch();
    expect(watch.read("call-thread")).toEqual(UNKNOWN_BOT_STATUS);
    expect(watch.read(null)).toEqual(UNKNOWN_BOT_STATUS);
    watch.register("call-thread", () => status({ state: "working" }));
    watch.reset();
    expect(watch.read("call-thread")).toEqual(UNKNOWN_BOT_STATUS);
  });
});
