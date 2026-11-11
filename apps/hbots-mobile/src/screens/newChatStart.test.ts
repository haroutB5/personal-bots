import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { describe, expect, it } from "vite-plus/test";

import { startChatResult } from "../chat/useStartChat";
import {
  MAX_START_FAILURES,
  NEW_CHAT_FAILED_MESSAGE,
  NEW_CHAT_INITIAL,
  NEW_CHAT_OFFLINE_MESSAGE,
  newChatMessage,
  stepNewChat,
  type NewChatEvent,
  type NewChatStart,
} from "./newChatStart";

const NOT_CONNECTED = new Error("Throwaway test is not connected.");

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
const failedWith = (error: Error): NewChatEvent => ({
  type: "result",
  result: startChatResult("t1", AsyncResult.failure(Cause.fail(error))),
});
const rejected: NewChatEvent = { type: "result", result: { kind: "rejected" } };
const timeout: NewChatEvent = { type: "timeout" };
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
    const states = play([link(true), failedWith(NOT_CONNECTED), link(false), link(true), started]);
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
    const [, afterFailure] = play([link(true), failedWith(NOT_CONNECTED)]);
    expect(afterFailure?.kind).not.toBe("failed");
  });

  it("goes offline after repeated transport failures, never showing the transport text", () => {
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1)
      events.push(link(true), failedWith(NOT_CONNECTED));
    expect(play(events).at(-1)).toEqual({ kind: "offline" });
  });

  it("shows any other failure at once, and Try again starts over", () => {
    const states = play([link(true), rejected, { type: "retry" }, link(true)]);
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "failed",
      "waiting",
      "starting",
    ]);
  });

  it("N3: a start with no reply in time is a dropped link, then offline after the cap", () => {
    expect(play([link(true), timeout]).at(-1)).toEqual({ kind: "waiting", failures: 1 });
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1) events.push(link(true), timeout);
    expect(play(events).at(-1)).toEqual({ kind: "offline" });
  });

  it("N3: a timeout outside a start changes nothing", () => {
    expect(play([timeout]).at(-1)).toEqual(NEW_CHAT_INITIAL);
    expect(play([link(true), started, timeout]).at(-1)).toEqual({
      kind: "started",
      threadId: "t1",
    });
  });

  it("ignores a late result after the chat started", () => {
    const states = play([link(true), started, failedWith(NOT_CONNECTED)]);
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

  it("reports a refusal with no text, and a success", () => {
    expect(startChatResult("t1", AsyncResult.failure(Cause.fail(new Error("Nope."))))).toEqual({
      kind: "rejected",
    });
    expect(startChatResult("t1", AsyncResult.success(undefined))).toEqual({
      kind: "started",
      threadId: "t1",
    });
  });
});

describe("N2: every socket error the RPC client raises is a dropped link, never screen text", () => {
  const cause = new Error("link lost");
  const reasons = [
    new Socket.SocketReadError({ cause }),
    new Socket.SocketWriteError({ cause }),
    new Socket.SocketOpenError({ kind: "Unknown", cause }),
    new Socket.SocketOpenError({ kind: "Timeout", cause }),
    new Socket.SocketCloseError({ code: 1006 }),
  ] as const;

  const startAfter = (reason: (typeof reasons)[number]) => {
    const result = startChatResult(
      "t1",
      AsyncResult.failure(Cause.fail(new RpcClientError.RpcClientError({ reason }))),
    );
    return play([link(true), { type: "result", result }]);
  };

  it.each(reasons.map((reason) => [reason._tag, reason] as const))(
    "%s waits for the link instead of failing",
    (_tag, reason) => {
      expect(startAfter(reason).at(-1)).toEqual({ kind: "waiting", failures: 1 });
    },
  );

  it.each(reasons.map((reason) => [reason._tag, reason] as const))(
    "%s three times ends offline",
    (_tag, reason) => {
      const results = Array.from({ length: MAX_START_FAILURES }, () => {
        const result = startChatResult(
          "t1",
          AsyncResult.failure(Cause.fail(new RpcClientError.RpcClientError({ reason }))),
        );
        return [link(true), { type: "result", result } as const];
      }).flat();
      expect(play(results).at(-1)).toEqual({ kind: "offline" });
    },
  );

  it("a failure that is not a dropped link reaches the failed state with no text in it", () => {
    const result = startChatResult(
      "t1",
      AsyncResult.failure(Cause.fail(new Error("db is locked"))),
    );
    const state = play([link(true), { type: "result", result }]).at(-1);
    expect(state).toEqual({ kind: "failed" });
  });
});

describe("newChatMessage", () => {
  it("is the offline copy offline, the plain failure copy on a refusal, and nothing otherwise", () => {
    expect(newChatMessage({ kind: "offline" })).toBe(NEW_CHAT_OFFLINE_MESSAGE);
    expect(newChatMessage({ kind: "failed" })).toBe(NEW_CHAT_FAILED_MESSAGE);
    expect(newChatMessage({ kind: "waiting", failures: 1 })).toBeNull();
    expect(newChatMessage({ kind: "starting", failures: 0 })).toBeNull();
    expect(newChatMessage({ kind: "started", threadId: "t1" })).toBeNull();
  });

  it("N2: the screen text after a SocketReadError never contains the error name", () => {
    const read = new RpcClientError.RpcClientError({
      reason: new Socket.SocketReadError({ cause: new Error("x") }),
    });
    const events: NewChatEvent[] = [];
    for (let i = 0; i < MAX_START_FAILURES; i += 1) events.push(link(true), failedWith(read));
    const state = play(events).at(-1);
    expect(state === undefined ? null : newChatMessage(state)).toBe(NEW_CHAT_OFFLINE_MESSAGE);
  });
});
