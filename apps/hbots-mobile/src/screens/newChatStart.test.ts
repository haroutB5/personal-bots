import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Cause } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_START_FAILURES,
  NEW_CHAT_INITIAL,
  stepNewChat,
  type NewChatEvent,
  type NewChatStart,
} from "./newChatStart";

const NOT_CONNECTED = "Throwaway test is not connected.";

function play(events: ReadonlyArray<NewChatEvent>): NewChatStart[] {
  const states: NewChatStart[] = [];
  let state = NEW_CHAT_INITIAL;
  for (const event of events) {
    state = stepNewChat(state, event);
    states.push(state);
  }
  return states;
}

const link = (connected: boolean): NewChatEvent => ({ type: "inputs", connected, hasTarget: true });
const failed = (message: string): NewChatEvent => ({
  type: "result",
  result: { kind: "failed", message },
});
const started: NewChatEvent = { type: "result", result: { kind: "started", threadId: "t1" } };

describe("stepNewChat", () => {
  it("does not start while the link is down, and starts once it is up", () => {
    const [down, up] = play([link(false), link(true)]);
    expect(down?.kind).toBe("waiting");
    expect(up?.kind).toBe("starting");
  });

  it("does not start without a target bot", () => {
    const [state] = play([{ type: "inputs", connected: true, hasTarget: false }]);
    expect(state?.kind).toBe("waiting");
  });

  it("a warm deep link that meets a dropped link ends in a started chat", () => {
    // The app resumes from the background: the first start is refused with "is not connected",
    // the link comes back, and the same screen starts again instead of showing the error.
    const states = play([link(true), failed(NOT_CONNECTED), link(false), link(true), started]);
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "waiting",
      "waiting",
      "starting",
      "started",
    ]);
    expect(states.at(-1)).toEqual({ kind: "started", threadId: "t1" });
  });

  it("never shows the transport error while a retry is still allowed", () => {
    const [, afterFailure] = play([link(true), failed(NOT_CONNECTED)]);
    expect(afterFailure?.kind).not.toBe("failed");
  });

  it("gives up with the error after repeated transport failures", () => {
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1) events.push(link(true), failed(NOT_CONNECTED));
    expect(play(events).at(-1)).toEqual({ kind: "failed", message: NOT_CONNECTED });
  });

  it("shows any other failure at once", () => {
    const states = play([link(true), failed("Couldn't start a chat. Try again.")]);
    expect(states.at(-1)).toEqual({ kind: "failed", message: "Couldn't start a chat. Try again." });
  });

  it("ignores a late result after the chat started", () => {
    const states = play([link(true), started, failed(NOT_CONNECTED)]);
    expect(states.at(-1)?.kind).toBe("started");
  });

  it("N1: a start interrupted while the link is down waits and goes again, and never shows the interrupt text", () => {
    const interruptMessage = (squashAtomCommandFailure({ cause: Cause.interrupt() }) as Error)
      .message;
    const states = play([link(true), failed(interruptMessage), link(false), link(true), started]);
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "waiting",
      "waiting",
      "starting",
      "started",
    ]);
  });

  it("N1: repeated interrupts end in the offline copy, never the interrupt text", () => {
    const interruptMessage = (squashAtomCommandFailure({ cause: Cause.interrupt() }) as Error)
      .message;
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1)
      events.push(link(true), failed(interruptMessage));
    const last = play(events).at(-1);
    expect(JSON.stringify(last)).not.toContain(interruptMessage);
  });
});
