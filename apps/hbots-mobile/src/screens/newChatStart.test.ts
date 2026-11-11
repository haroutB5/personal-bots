import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { startChatResult } from "../chat/useStartChat";
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
const interrupted: NewChatEvent = { type: "result", result: { kind: "interrupted" } };
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

  it("goes offline after repeated transport failures, never showing the transport text", () => {
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1) events.push(link(true), failed(NOT_CONNECTED));
    expect(play(events).at(-1)).toEqual({ kind: "offline" });
  });

  it("shows any other failure at once", () => {
    const states = play([link(true), failed("Couldn't start a chat. Try again.")]);
    expect(states.at(-1)).toEqual({ kind: "failed", message: "Couldn't start a chat. Try again." });
  });

  it("ignores a late result after the chat started", () => {
    const states = play([link(true), started, failed(NOT_CONNECTED)]);
    expect(states.at(-1)?.kind).toBe("started");
  });

  it("N1: a start interrupted while the link is down waits and goes again", () => {
    const states = play([link(true), interrupted, link(false), link(true), started]);
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "waiting",
      "waiting",
      "starting",
      "started",
    ]);
  });

  it("N1: repeated interrupts end offline, with no text to show", () => {
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1) events.push(link(true), interrupted);
    expect(play(events).at(-1)).toEqual({ kind: "offline" });
  });

  it("N1: offline starts again when the link drops and returns, or on retry", () => {
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1) events.push(link(true), interrupted);
    const viaLink = play([...events, link(false), link(true)]);
    expect(viaLink.at(-2)).toEqual(NEW_CHAT_INITIAL);
    expect(viaLink.at(-1)?.kind).toBe("starting");
    const viaRetry = play([...events, { type: "retry" }, link(true)]);
    expect(viaRetry.at(-1)?.kind).toBe("starting");
  });

  it("a retry changes nothing outside offline", () => {
    const states = play([link(true), { type: "retry" }]);
    expect(states.at(-1)).toEqual({ kind: "starting", failures: 0 });
  });
});

describe("startChatResult", () => {
  it("N1: an interrupt-only cause carries no interrupt text", () => {
    const result = startChatResult("t1", AsyncResult.failure(Cause.interrupt()));
    expect(result).toEqual({ kind: "interrupted" });
  });

  it("keeps a real failure message and a success", () => {
    expect(startChatResult("t1", AsyncResult.failure(Cause.fail(new Error("Nope."))))).toEqual({
      kind: "failed",
      message: "Nope.",
    });
    expect(startChatResult("t1", AsyncResult.success(undefined))).toEqual({
      kind: "started",
      threadId: "t1",
    });
  });
});
