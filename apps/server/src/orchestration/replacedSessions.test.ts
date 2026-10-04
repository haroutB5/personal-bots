import { beforeEach, describe, expect, it } from "@effect/vitest";

import {
  clearReplacedSessions,
  consumeReplacedSessionExit,
  markSessionReplaced,
  peekReplacedSession,
  REPLACED_SESSION_EXIT_WINDOW_MS,
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

  it("an exit from before the stop is not the stop's", () => {
    markSessionReplaced({ threadId: "t1", provider: "codex", nowMs: NOW });
    expect(
      consumeReplacedSessionExit({ threadId: "t1", provider: "codex", eventAtMs: NOW - 60_000 }),
    ).toBe(false);
  });
});
