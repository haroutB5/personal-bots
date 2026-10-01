import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  decideTaskChatArchive,
  TASK_CHAT_AUTO_ARCHIVE_IDLE_MS,
  taskChatAutoArchiveEnabled,
  type TaskChatArchiveCandidate,
} from "./taskChatAutoArchivePolicy.ts";

const DONE = Date.parse("2026-09-28T18:10:00.000Z");
const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const candidate = (over: Partial<TaskChatArchiveCandidate> = {}): TaskChatArchiveCandidate => ({
  threadId: "t1",
  botId: "b1",
  botName: "Backend",
  title: "Task",
  chatKind: "delegation",
  createdAt: at(DONE - 10 * 60_000),
  taskEndedAt: at(DONE),
  lastMessageAt: at(DONE - 1_000),
  lastOwnerMessageAt: null,
  lastViewedAt: null,
  sessionStatus: "ready",
  activeTurnId: null,
  pendingRequests: 0,
  ...over,
});

describe("decideTaskChatArchive", () => {
  it("keeps unopened routine reports until exactly 24 hours old, including long runs", () => {
    const run = candidate({ chatKind: "routine", createdAt: at(DONE) });
    const due = DONE + 24 * 60 * 60_000;
    expect(decideTaskChatArchive(run, due - 1)).toMatchObject({ kind: "keep", dueAtMs: due });
    expect(decideTaskChatArchive(run, due).kind).toBe("archive");
    expect(decideTaskChatArchive({ ...run, taskEndedAt: at(due) }, due).kind).toBe("archive");
    expect(decideTaskChatArchive({ ...run, sessionStatus: "running" }, due).kind).toBe("keep");
  });

  it("waits for 30 idle minutes after opening a routine report, including older reports", () => {
    const viewed = DONE + 25 * 60 * 60_000;
    const run = candidate({ chatKind: "routine", createdAt: at(DONE), lastViewedAt: at(viewed) });
    expect(decideTaskChatArchive(run, viewed + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS - 1).kind).toBe(
      "keep",
    );
    expect(decideTaskChatArchive(run, viewed + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS).kind).toBe(
      "archive",
    );
  });

  it("archives exactly 30 minutes after the latest of task end, last message and last open", () => {
    expect(TASK_CHAT_AUTO_ARCHIVE_IDLE_MS).toBe(30 * 60_000);
    const due = DONE + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS;
    expect(decideTaskChatArchive(candidate(), due - 1)).toEqual({
      kind: "keep",
      reason: "recent",
      dueAtMs: due,
    });
    expect(decideTaskChatArchive(candidate(), due)).toEqual({ kind: "archive", idleSinceMs: DONE });
    const opened = candidate({ lastViewedAt: at(DONE + 20 * 60_000) });
    expect(decideTaskChatArchive(opened, due).kind).toBe("keep");
    const written = candidate({ lastMessageAt: at(DONE + 25 * 60_000) });
    expect(decideTaskChatArchive(written, due + 20 * 60_000).kind).toBe("keep");
    expect(decideTaskChatArchive(written, due + 25 * 60_000).kind).toBe("archive");
  });

  it("keeps a chat with a live turn, background work or a pending question", () => {
    const late = DONE + 10 * TASK_CHAT_AUTO_ARCHIVE_IDLE_MS;
    expect(decideTaskChatArchive(candidate({ sessionStatus: "running" }), late)).toMatchObject({
      reason: "live_turn",
    });
    expect(decideTaskChatArchive(candidate({ activeTurnId: "turn-1" }), late)).toMatchObject({
      reason: "live_turn",
    });
    expect(
      decideTaskChatArchive(candidate(), late, {
        backgroundWork: true,
        latestTurnCompletedAt: null,
      }),
    ).toMatchObject({ reason: "background_work" });
    expect(decideTaskChatArchive(candidate({ pendingRequests: 1 }), late)).toMatchObject({
      reason: "pending_request",
    });
  });

  it("reads the stored setting as on unless it says off", () => {
    expect(taskChatAutoArchiveEnabled(null)).toBe(true);
    expect(taskChatAutoArchiveEnabled("on")).toBe(true);
    expect(taskChatAutoArchiveEnabled("off")).toBe(false);
  });
});
