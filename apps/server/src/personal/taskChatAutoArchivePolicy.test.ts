import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { PERSONAL_TASK_TERMINAL_STATUSES } from "@t3tools/contracts";

import {
  decideTaskChatArchive,
  ROUTINE_CHAT_AUTO_ARCHIVE_UNREAD_MS,
  TASK_CHAT_AUTO_ARCHIVE_AFTER_META_KEY,
  TASK_CHAT_AUTO_ARCHIVE_IDLE_MS,
  TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL,
  TASK_CHAT_OPEN_WORK_SQL,
  TASK_TERMINAL_STATUSES,
  taskChatAutoArchiveEnabled,
  taskChatAutoArchiveIdleMs,
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
  it("keeps unopened routine reports until exactly 48 hours old, including long runs", () => {
    expect(ROUTINE_CHAT_AUTO_ARCHIVE_UNREAD_MS).toBe(48 * 60 * 60_000);
    const run = candidate({ chatKind: "routine", createdAt: at(DONE) });
    const due = DONE + ROUTINE_CHAT_AUTO_ARCHIVE_UNREAD_MS;
    expect(decideTaskChatArchive(run, due - 1)).toMatchObject({ kind: "keep", dueAtMs: due });
    expect(decideTaskChatArchive(run, due).kind).toBe("archive");
    expect(decideTaskChatArchive({ ...run, taskEndedAt: at(due) }, due).kind).toBe("archive");
    expect(decideTaskChatArchive({ ...run, sessionStatus: "running" }, due).kind).toBe("keep");
  });

  it("waits for 48 idle hours after opening a routine report, including older reports", () => {
    const viewed = DONE + 49 * 60 * 60_000;
    const run = candidate({ chatKind: "routine", createdAt: at(DONE), lastViewedAt: at(viewed) });
    expect(decideTaskChatArchive(run, viewed + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS - 1).kind).toBe(
      "keep",
    );
    expect(decideTaskChatArchive(run, viewed + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS).kind).toBe(
      "archive",
    );
  });

  it("archives exactly 48 hours after the latest of task end, last message and last open", () => {
    expect(TASK_CHAT_AUTO_ARCHIVE_IDLE_MS).toBe(48 * 60 * 60_000);
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

  it("uses the saved wait for both waits, and keeps 48 hours when none is set", () => {
    expect(TASK_CHAT_AUTO_ARCHIVE_AFTER_META_KEY).toBe("taskChatAutoArchiveAfterMinutes");
    // The stored minutes, and the default when the row is absent or unusable.
    expect(taskChatAutoArchiveIdleMs(null)).toBe(TASK_CHAT_AUTO_ARCHIVE_IDLE_MS);
    expect(taskChatAutoArchiveIdleMs("30")).toBe(30 * 60_000);
    expect(taskChatAutoArchiveIdleMs("2880")).toBe(48 * 60 * 60_000);
    expect(taskChatAutoArchiveIdleMs("not a number")).toBe(TASK_CHAT_AUTO_ARCHIVE_IDLE_MS);
    expect(taskChatAutoArchiveIdleMs("0")).toBe(TASK_CHAT_AUTO_ARCHIVE_IDLE_MS);

    const short = 30 * 60_000;
    // A finished delegated task: not due one minute before 30, due at exactly 30.
    const task = candidate();
    expect(decideTaskChatArchive(task, DONE + short - 1, undefined, short)).toEqual({
      kind: "keep",
      reason: "recent",
      dueAtMs: DONE + short,
    });
    expect(decideTaskChatArchive(task, DONE + short, undefined, short)).toEqual({
      kind: "archive",
      idleSinceMs: DONE,
    });

    // An unread routine report: the same wait, from the chat's creation.
    const run = candidate({ chatKind: "routine", createdAt: at(DONE) });
    expect(decideTaskChatArchive(run, DONE + short - 1, undefined, short)).toEqual({
      kind: "keep",
      reason: "recent",
      dueAtMs: DONE + short,
    });
    expect(decideTaskChatArchive(run, DONE + short, undefined, short).kind).toBe("archive");

    // No fourth argument is the old behaviour: 30 minutes is far too soon.
    expect(decideTaskChatArchive(task, DONE + short).kind).toBe("keep");
    expect(decideTaskChatArchive(task, DONE + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS).kind).toBe("archive");
  });
});

describe("finished task statuses", () => {
  it("count interrupted as finished, in step with the task contract and the SQL", () => {
    expect([...TASK_TERMINAL_STATUSES].sort()).toEqual([...PERSONAL_TASK_TERMINAL_STATUSES].sort());
    expect(TASK_TERMINAL_STATUSES).toContain("interrupted");
    const list = "('completed', 'failed', 'interrupted', 'cancelled')";
    expect(TASK_CHAT_OPEN_WORK_SQL).toContain(`NOT IN ${list}`);
    expect(TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL).toContain(`o.status NOT IN ${list}`);
    expect(TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL).toContain(`c.status NOT IN ${list}`);
  });
});
