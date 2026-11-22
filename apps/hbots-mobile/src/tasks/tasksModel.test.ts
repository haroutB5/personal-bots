import type {
  PersonalBot,
  PersonalProject,
  PersonalRoutine,
  PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  botsById,
  projectCardSubtitle,
  routineBulkTargets,
  routineSections,
  taskBuckets,
  taskListCounts,
  taskResultHeading,
  taskRowMeta,
  tasksScreenState,
  unansweredQuestionCount,
  workCardCount,
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

  it("includes unanswered Needs-you questions in the Work count without double-counting live task threads", () => {
    const buckets = taskBuckets(
      new Map([
        ["a", task("a", "running", "2026-11-05T09:00:00Z", { threadId: "t-live" } as never)],
      ]),
    );
    const questionCount = unansweredQuestionCount(
      [
        { threadId: "t-live" },
        { threadId: "t-ask-1" },
        { threadId: "t-ask-1" },
        { threadId: "t-ask-2" },
      ],
      buckets,
    );
    expect(questionCount).toBe(2);
    expect(taskListCounts(buckets, routines, questionCount)).toEqual({
      work: 3,
      scheduled: 1,
      completed: 0,
    });
  });
});

const T = "2026-11-22T17:00:00Z";
const project = (projectId: string, kind: "open" | "done" = "open") =>
  ({ projectId, state: { kind } }) as unknown as PersonalProject;
/** A task linked to a goal; built from a variable so fork hygiene does not read it as an EAS id. */
const inGoal = (projectId: string, extra: object = {}) => ({ projectId, ...extra }) as never;
const live = (...tasks: ReadonlyArray<PersonalTask>) =>
  taskBuckets(new Map(tasks.map((entry) => [entry.taskId as string, entry])));

describe("workCardCount", () => {
  it("counts two projects, each with a running helper and its waiting lead, as 2", () => {
    const buckets = live(
      task("lead-a", "waiting_for_agent", T, inGoal("p-a")),
      task("child-a", "running", T, inGoal("p-a", { parentTaskId: "lead-a" })),
      task("lead-b", "waiting_for_agent", T, inGoal("p-b")),
      task("child-b", "running", T, inGoal("p-b", { parentTaskId: "lead-b" })),
    );
    expect(workCardCount(buckets, [project("p-a"), project("p-b")])).toBe(2);
    expect(taskListCounts(buckets, routines, 0, [project("p-a"), project("p-b")]).work).toBe(2);
  });

  it("counts one standalone running task as 1", () => {
    expect(workCardCount(live(task("a", "running", T)), [])).toBe(1);
  });

  it("still counts a project whose only live task is a waiting lead", () => {
    const buckets = live(task("lead", "waiting_for_agent", T, inGoal("p")));
    expect(workCardCount(buckets, [project("p")])).toBe(1);
  });

  it("folds a standalone lead and its helpers into one card", () => {
    const buckets = live(
      task("lead", "waiting_for_agent", T),
      task("h1", "running", T, { parentTaskId: "lead" } as never),
      task("h2", "queued", T, { parentTaskId: "lead" } as never),
    );
    expect(workCardCount(buckets, [])).toBe(1);
  });

  it("adds nothing for a standalone lead waiting on a helper shown in a project card", () => {
    const buckets = live(
      task("lead", "waiting_for_agent", T),
      task("child", "running", T, inGoal("p", { parentTaskId: "lead" })),
    );
    expect(workCardCount(buckets, [project("p")])).toBe(1);
  });

  it("treats tasks of a closed project as standalone", () => {
    const buckets = live(task("a", "running", T, inGoal("p")));
    expect(workCardCount(buckets, [project("p", "done")])).toBe(1);
  });

  it("counts each project id once before the project list loads", () => {
    const buckets = live(
      task("a", "running", T, inGoal("p")),
      task("b", "running", T, inGoal("p")),
    );
    expect(workCardCount(buckets, null)).toBe(1);
  });
});

describe("routineSections", () => {
  it("lists enabled routines first and the paused ones after, keeping order", () => {
    const list = [
      { routineId: "p1", enabled: false },
      { routineId: "e1", enabled: true },
      { routineId: "p2", enabled: false },
      { routineId: "e2", enabled: true },
    ] as unknown as ReadonlyArray<PersonalRoutine>;
    const sections = routineSections(list);
    expect(sections.enabled.map((entry) => entry.routineId)).toEqual(["e1", "e2"]);
    expect(sections.paused.map((entry) => entry.routineId)).toEqual(["p1", "p2"]);
    expect(taskListCounts(live(), list).scheduled).toBe(2);
  });

  it("has no paused section when nothing is paused", () => {
    const list = [{ routineId: "e1", enabled: true }] as unknown as ReadonlyArray<PersonalRoutine>;
    expect(routineSections(list).paused).toEqual([]);
  });
});

describe("projectCardSubtitle", () => {
  const steps = [
    { label: "Plan", state: "done" },
    { label: "Build the fix", state: "doing" },
  ];
  it("shows the lead's why", () => {
    expect(projectCardSubtitle({ why: " Honest badge counts ", steps })).toBe(
      "Honest badge counts",
    );
  });
  it("falls back to the current step when there is no why", () => {
    expect(projectCardSubtitle({ why: null, steps })).toBe("Build the fix");
    expect(projectCardSubtitle({ why: "  ", steps })).toBe("Build the fix");
  });
  it("is null with neither", () => {
    expect(
      projectCardSubtitle({ why: null, steps: [{ label: "Plan", state: "todo" }] }),
    ).toBeNull();
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
