import { beforeEach, describe, expect, it } from "@effect/vitest";

import {
  clearReplacedSessions,
  consumeReplacedSessionExit,
  markSessionReplaced,
  peekReplacedSession,
  peekReplacedSessions,
  REPLACED_SESSION_EXIT_WINDOW_MS,
  unmarkSessionReplaced,
} from "./replacedSessions.ts";

const NOW = Date.parse("2026-10-04T20:00:00.000Z");

describe("the exit of a session a fresh one replaced", () => {
  beforeEach(() => clearReplacedSessions());

  it("is the first exit of the same session after the stop, once", () => {
    markSessionReplaced({
      threadId: "t1",
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      nowMs: NOW,
    });
    const exit = {
      threadId: "t1",
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      eventAtMs: NOW + 300,
    };
    expect(consumeReplacedSessionExit(exit)).toBe(true);
    // The new session's own exit, later, is the thread's.
    expect(consumeReplacedSessionExit({ ...exit, eventAtMs: NOW + 900 })).toBe(false);
  });

  it("is not another thread's, another provider's or another instance's exit", () => {
    markSessionReplaced({
      threadId: "t1",
      provider: "claudeAgent",
      instanceId: "claude_a",
      nowMs: NOW,
    });
    const base = { provider: "claudeAgent", instanceId: "claude_a", eventAtMs: NOW + 100 };
    expect(consumeReplacedSessionExit({ ...base, threadId: "t2" })).toBe(false);
    expect(consumeReplacedSessionExit({ ...base, threadId: "t1", provider: "codex" })).toBe(false);
    expect(consumeReplacedSessionExit({ ...base, threadId: "t1", instanceId: "claude_b" })).toBe(
      false,
    );
    // Still waiting for its own exit.
    expect(consumeReplacedSessionExit({ ...base, threadId: "t1" })).toBe(true);
  });

  it("matches by driver when an event names no instance", () => {
    markSessionReplaced({ threadId: "t1", provider: "codex", instanceId: "codex", nowMs: NOW });
    expect(
      consumeReplacedSessionExit({ threadId: "t1", provider: "codex", eventAtMs: NOW + 50 }),
    ).toBe(true);
  });

  it("expires: a later exit is the thread's own, and the mark is gone", () => {
    markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW });
    expect(
      consumeReplacedSessionExit({
        threadId: "t1",
        provider: "codex",
        eventAtMs: NOW + REPLACED_SESSION_EXIT_WINDOW_MS + 1,
      }),
    ).toBe(false);
    expect(peekReplacedSession("t1")).toBeUndefined();
  });

  it("waits 30 seconds for the exit", () => {
    expect(REPLACED_SESSION_EXIT_WINDOW_MS).toBe(30_000);
    markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW });
    expect(
      consumeReplacedSessionExit({ threadId: "t1", provider: "codex", eventAtMs: NOW + 25_000 }),
    ).toBe(true);
  });

  it("several marks wait on one thread and an exit uses up the oldest one that matches", () => {
    const first = markSessionReplaced({
      threadId: "t1",
      provider: "claudeAgent",
      instanceId: "claude_a",
      nowMs: NOW,
    });
    const second = markSessionReplaced({
      threadId: "t1",
      provider: "claudeAgent",
      instanceId: "claude_a",
      nowMs: NOW + 1_000,
    });
    const other = markSessionReplaced({
      threadId: "t1",
      provider: "codex",
      instanceId: "codex",
      nowMs: NOW + 500,
    });
    expect(peekReplacedSessions("t1").map((mark) => mark.id)).toEqual([first, other, second]);
    const exit = (provider: string, instanceId: string, at: number) =>
      consumeReplacedSessionExit({ threadId: "t1", provider, instanceId, eventAtMs: NOW + at });
    // The Claude exit takes the older Claude mark, not the newer one and not the Codex one.
    expect(exit("claudeAgent", "claude_a", 2_000)).toBe(true);
    expect(peekReplacedSessions("t1").map((mark) => mark.id)).toEqual([other, second]);
    // The Codex exit takes the Codex mark.
    expect(exit("codex", "codex", 2_100)).toBe(true);
    expect(peekReplacedSessions("t1").map((mark) => mark.id)).toEqual([second]);
    expect(exit("claudeAgent", "claude_a", 2_200)).toBe(true);
    expect(peekReplacedSession("t1")).toBeUndefined();
    // Nothing left: the next exit is the thread's own.
    expect(exit("claudeAgent", "claude_a", 2_300)).toBe(false);
  });

  it("an expired mark does not stand in front of a newer one", () => {
    markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW });
    const newer = markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW + 60_000 });
    expect(
      consumeReplacedSessionExit({ threadId: "t1", provider: "codex", eventAtMs: NOW + 61_000 }),
    ).toBe(true);
    expect(peekReplacedSessions("t1").map((mark) => mark.id)).not.toContain(newer);
    expect(peekReplacedSession("t1")).toBeUndefined();
  });

  it("taking a mark back removes only that one, and a stop that stopped nothing leaves none waiting", () => {
    const a = markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW });
    const b = markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW + 100 });
    unmarkSessionReplaced("t1", b);
    expect(peekReplacedSessions("t1").map((mark) => mark.id)).toEqual([a]);
    unmarkSessionReplaced("t1", a);
    expect(peekReplacedSession("t1")).toBeUndefined();
    // No exit is swallowed afterwards.
    expect(
      consumeReplacedSessionExit({ threadId: "t1", provider: "codex", eventAtMs: NOW + 200 }),
    ).toBe(false);
    // Taking back a mark that is gone changes nothing.
    unmarkSessionReplaced("t1", a);
    unmarkSessionReplaced("unknown", 99);
  });

  it("keeps a handful of marks per thread: the oldest go first", () => {
    for (let index = 0; index < 12; index++) {
      markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW + index });
    }
    expect(peekReplacedSessions("t1")).toHaveLength(8);
    expect(peekReplacedSession("t1")!.atMs).toBe(NOW + 4);
  });

  it("an exit from before the stop is not the stop's", () => {
    markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW });
    expect(
      consumeReplacedSessionExit({ threadId: "t1", provider: "codex", eventAtMs: NOW - 60_000 }),
    ).toBe(false);
  });
});
