import { type PersonalRoutine, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  canCancelTask,
  canRetryTask,
  formatLocalDateTime,
  mergeTaskLists,
  parseTaskListFilter,
  routineNextRunLabel,
  stopTaskConfirmMessage,
  TASK_LIST_FILTERS,
  taskListFor,
  taskListCountNeedsAttention,
  taskStatusTone,
} from "./taskPresentation";

describe("task list tabs", () => {
  it("fit a phone row: no label longer than the widest that fits beside a count", () => {
    expect(TASK_LIST_FILTERS.map((filter) => filter.label)).toEqual([
      "Active",
      "Waiting",
      "Scheduled",
      "Done",
    ]);
  });

  it("emphasise only the counts that need attention", () => {
    expect(taskListCountNeedsAttention("active")).toBe(true);
    expect(taskListCountNeedsAttention("waiting")).toBe(true);
    expect(taskListCountNeedsAttention("scheduled")).toBe(false);
    expect(taskListCountNeedsAttention("completed")).toBe(false);
  });
});

describe("task lists", () => {
  it("puts every status in exactly one list", () => {
    expect(taskListFor("running")).toBe("active");
    expect(taskListFor("rate_limited")).toBe("active");
    expect(taskListFor("waiting_for_user")).toBe("waiting");
    expect(taskListFor("waiting_for_agent")).toBe("waiting");
    expect(taskListFor("cancelled")).toBe("completed");
    expect(taskListFor("failed")).toBe("completed");
  });

  it("parses the view search param, defaulting to Active", () => {
    expect(parseTaskListFilter("scheduled")).toBe("scheduled");
    expect(parseTaskListFilter("bogus")).toBe("active");
    expect(parseTaskListFilter(undefined)).toBe("active");
  });

  it("offers Cancel only for live tasks and Retry only for retryable ones", () => {
    expect(canCancelTask("running")).toBe(true);
    expect(canCancelTask("completed")).toBe(false);
    expect(canRetryTask("failed")).toBe(true);
    expect(canRetryTask("completed")).toBe(false);
    expect(canRetryTask("running")).toBe(false);
  });

  it("marks only real attention states", () => {
    expect(taskStatusTone("running")).toBe("live");
    expect(taskStatusTone("waiting_for_user")).toBe("review");
    expect(taskStatusTone("queued")).toBe("none");
  });
});

describe("formatLocalDateTime", () => {
  it("renders London wall time across DST", () => {
    expect(formatLocalDateTime(Date.parse("2026-09-14T08:00:00Z"))).toBe("Mon 14 Sep, 09:00");
    expect(formatLocalDateTime(Date.parse("2026-12-14T08:00:00Z"))).toBe("Mon 14 Dec, 08:00");
    expect(formatLocalDateTime(Date.parse("2026-09-14T08:00:00Z"), "America/New_York")).toBe(
      "Mon 14 Sep, 04:00",
    );
  });

  it("uses the Scheduled list's next-run states", () => {
    const routine = {
      enabled: true,
      nextDueAt: DateTime.makeUnsafe("2026-09-14T08:00:00Z"),
      timeZone: "Europe/London",
    } as PersonalRoutine;
    expect(routineNextRunLabel(routine)).toBe("Next: Mon 14 Sep, 09:00");
    expect(routineNextRunLabel({ ...routine, enabled: false })).toBe("Paused");
    expect(routineNextRunLabel({ ...routine, nextDueAt: null })).toBe("No more runs");
  });

  // QA v1.10.0 BUG-9: a UTC routine read "Thu 17 Sep, 23:00" to a user in BST.
  it("shows a routine's next run in the user's zone, not the routine's", () => {
    const utc = {
      enabled: true,
      nextDueAt: DateTime.makeUnsafe("2026-09-17T23:00:00Z"),
      timeZone: "UTC",
    } as PersonalRoutine;
    expect(routineNextRunLabel(utc)).toBe("Next: Fri 18 Sep, 00:00");
  });
});

describe("stop task confirm", () => {
  it("names the task and says the work in progress is lost", () => {
    expect(stopTaskConfirmMessage("  Refresh the fixtures ")).toBe(
      "Stop Refresh the fixtures?\nThe bot stops now; work in progress is lost.",
    );
  });

  it("falls back to a generic name for a blank title", () => {
    expect(stopTaskConfirmMessage("   ")).toBe(
      "Stop this task?\nThe bot stops now; work in progress is lost.",
    );
  });
});

describe("mergeTaskLists", () => {
  const decodeTask = Schema.decodeUnknownSync(PersonalTask);
  const task = (taskId: string, updatedAt: string, status = "completed") =>
    decodeTask({
      taskId,
      rootTaskId: taskId,
      parentTaskId: null,
      botId: "bot-assistant",
      threadId: null,
      title: taskId,
      objective: "",
      acceptanceCriteria: "",
      expectedOutput: "",
      status,
      source: "user",
      idempotencyKey: `key-${taskId}`,
      depth: 0,
      maxDepth: 2,
      maxChildren: 4,
      result: null,
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      createdAt: "2026-09-13T04:00:00.000Z",
      updatedAt,
      startedAt: null,
      completedAt: null,
      detailOmitted: true,
    });

  it("adds tasks the feed does not carry and keeps the feed map when nothing is added", () => {
    const feed = new Map([["recent", task("recent", "2026-09-20T00:00:00.000Z")]]);
    expect(mergeTaskLists(feed, [])).toBe(feed);
    expect(mergeTaskLists(feed, null)).toBe(feed);
    expect(mergeTaskLists(null, [task("old", "2026-09-01T00:00:00.000Z")])).toBeNull();
    const merged = mergeTaskLists(feed, [task("old", "2026-09-01T00:00:00.000Z")]);
    expect([...merged!.keys()].toSorted()).toEqual(["old", "recent"]);
  });

  it("keeps the newer copy of a task both carry", () => {
    const live = task("t", "2026-09-20T00:00:00.000Z", "running");
    const stale = task("t", "2026-09-19T00:00:00.000Z", "queued");
    const newer = task("t", "2026-09-21T00:00:00.000Z", "completed");
    expect(mergeTaskLists(new Map([["t", live]]), [stale])!.get("t")).toBe(live);
    expect(mergeTaskLists(new Map([["t", live]]), [newer])!.get("t")).toBe(newer);
  });
});
