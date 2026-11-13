import type { PersonalBot, PersonalRoutine, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  botsById,
  routineBulkTargets,
  taskBuckets,
  taskListCounts,
  taskResultHeading,
  taskRowMeta,
  tasksScreenState,
} from "./tasksModel";

function task(
  taskId: string,
  status: PersonalTask["status"],
  updatedAt: string,
  extra: Partial<PersonalTask> = {},
): PersonalTask {
  return {
    taskId,
    status,
    updatedAt: DateTime.makeUnsafe(Date.parse(updatedAt)),
    source: "user",
    botId: "bot-1",
    title: `Title ${taskId}`,
    parentTaskId: null,
    result: null,
    ...extra,
  } as PersonalTask;
}

const routines = [
  { routineId: "r1", enabled: true },
  { routineId: "r2", enabled: false },
] as unknown as ReadonlyArray<PersonalRoutine>;

const noTasks = { tasks: null, taskError: null, routinesLoaded: true, routinesError: null };

describe("taskBuckets", () => {
  it("puts each task in its tab, newest update first", () => {
    const buckets = taskBuckets(
      new Map([
        ["a", task("a", "running", "2026-11-05T09:00:00Z")],
        ["b", task("b", "failed", "2026-11-05T10:00:00Z")],
        ["c", task("c", "waiting_for_user", "2026-11-05T11:00:00Z")],
        ["d", task("d", "queued", "2026-11-05T12:00:00Z")],
      ]),
    );
    expect(buckets.active.map((entry) => entry.taskId)).toEqual(["d", "a"]);
    expect(buckets.waiting.map((entry) => entry.taskId)).toEqual(["c"]);
    expect(buckets.completed.map((entry) => entry.taskId)).toEqual(["b"]);
  });

  it("reads an empty feed as no rows, not as a missing feed", () => {
    expect(taskBuckets(null)).toEqual({ active: [], waiting: [], completed: [] });
  });
});

describe("taskListCounts", () => {
  it("counts only enabled routines under Scheduled", () => {
    const buckets = taskBuckets(new Map([["a", task("a", "running", "2026-11-05T09:00:00Z")]]));
    expect(taskListCounts(buckets, routines)).toEqual({
      work: 1,
      scheduled: 1,
      completed: 0,
    });
  });
});

describe("tasksScreenState", () => {
  it("shows loading until the active view has data", () => {
    expect(tasksScreenState({ ...noTasks, view: "work" })).toEqual({ kind: "loading" });
  });

  it("shows the error instead of stale rows", () => {
    expect(
      tasksScreenState({ ...noTasks, view: "work", taskError: "Can't reach your laptop." }),
    ).toEqual({ kind: "error", message: "Can't reach your laptop." });
  });

  it("reads Scheduled from the routines query and the task tabs from the feed", () => {
    expect(
      tasksScreenState({
        view: "scheduled",
        tasks: new Map(),
        taskError: null,
        routinesLoaded: false,
        routinesError: null,
      }),
    ).toEqual({ kind: "loading" });
    expect(
      tasksScreenState({
        ...noTasks,
        view: "completed",
        tasks: new Map(),
      }),
    ).toEqual({ kind: "ready" });
  });
});

describe("taskRowMeta", () => {
  it("names the bot, the status and where the task came from", () => {
    const routine = task("a", "completed", "2026-11-05T09:00:00Z", { source: "routine" });
    expect(taskRowMeta(routine, "Planner", null)).toBe("Planner · Done · Routine");
  });

  it("prefers the parent title over the routine label", () => {
    const child = task("a", "completed", "2026-11-05T09:00:00Z", { source: "routine" });
    expect(taskRowMeta(child, "Builder", "Ship the app")).toBe(
      'Builder · Done · for "Ship the app"',
    );
  });

  it("says Deleted bot when the bot is gone", () => {
    expect(taskRowMeta(task("a", "failed", "2026-11-05T09:00:00Z"), null, null)).toBe(
      "Deleted bot · Failed",
    );
  });
});

describe("routineBulkTargets", () => {
  it("pauses enabled picks and resumes paused ones, leaving the rest alone", () => {
    expect(routineBulkTargets(routines, ["r1", "r2"])).toEqual({
      toPause: ["r1"],
      toResume: ["r2"],
    });
    expect(routineBulkTargets(routines, ["r1"])).toEqual({ toPause: ["r1"], toResume: [] });
  });
});

describe("botsById", () => {
  it("indexes bots for the rows, and tolerates the list not loading", () => {
    const bot = { botId: "bot-1", name: "Planner" } as PersonalBot;
    expect(botsById([bot]).get("bot-1")).toBe(bot);
    expect(botsById(undefined).size).toBe(0);
  });
});

describe("taskResultHeading", () => {
  it("says the reply is still in progress while background work runs", () => {
    expect(
      taskResultHeading(
        task("a", "running", "2026-11-05T09:00:00Z", {
          result: { summary: "So far", waitingOnBackgroundSince: "2026-11-05T09:00:00Z" },
        }),
      ),
    ).toBe("Reply so far (still finishing background work)");
    expect(taskResultHeading(task("a", "completed", "2026-11-05T09:00:00Z"))).toBe("Result");
  });
});
