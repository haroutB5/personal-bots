import type { PersonalProject, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildGoalTimeline, goalTimelineTime } from "./goalTimeline.ts";

const local = (hour: number, minute: number) => new Date(2026, 10, 14, hour, minute, 0, 0);
const iso = (hour: number, minute: number) =>
  DateTime.makeUnsafe(local(hour, minute).toISOString());

const NAMES: Record<string, string> = { poteto: "Poteto", developer: "Developer" };
const botName = (botId: string) => NAMES[botId] ?? botId;

function project(input: {
  readonly createdAt: DateTime.Utc;
  readonly state?: PersonalProject["state"];
}): PersonalProject {
  return {
    projectId: "goal-1",
    leadBotId: "poteto",
    threadId: null,
    name: "Kino",
    steps: [{ label: "Build", state: "doing" }],
    estimate: null,
    state: input.state ?? { kind: "open" },
    lastActivityAt: input.createdAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    why: null,
  } as unknown as PersonalProject;
}

function task(input: {
  readonly id: string;
  readonly status: PersonalTask["status"];
  readonly startedAt?: DateTime.Utc | null;
  readonly completedAt?: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc;
}): PersonalTask {
  return {
    taskId: input.id,
    rootTaskId: input.id,
    parentTaskId: null,
    botId: "developer",
    threadId: null,
    title: "Build the goal sheet",
    objective: "o",
    acceptanceCriteria: "a",
    expectedOutput: "e",
    status: input.status,
    source: "delegation",
    idempotencyKey: input.id,
    depth: 1,
    maxDepth: 3,
    maxChildren: 5,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: iso(19, 0),
    updatedAt: input.updatedAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    projectId: "goal-1",
  } as unknown as PersonalTask;
}

describe("buildGoalTimeline", () => {
  it("reads the design's goal newest first, from the finished task back to the goal opening", () => {
    const timeline = buildGoalTimeline({
      project: project({ createdAt: iso(18, 5) }),
      history: [{ kind: "step", at: iso(19, 58), label: "Verify on emulator", state: "done" }],
      tasks: [
        task({
          id: "t1",
          status: "completed",
          startedAt: iso(19, 31),
          completedAt: iso(21, 10),
          updatedAt: iso(21, 10),
        }),
      ],
      botName,
    });
    expect(timeline.map((entry) => entry.text)).toEqual([
      "Developer finished · Build the goal sheet",
      "Step done · Verify on emulator",
      "Developer started · Build the goal sheet",
      "Goal opened by Poteto.",
    ]);
    expect(goalTimelineTime(timeline[0]!.atMs, local(21, 30).getTime())).toBe("21:10");
    expect(goalTimelineTime(timeline.at(-1)!.atMs, local(21, 30).getTime())).toBe("18:05");
  });

  it("names started, done, reopened and replanned changes", () => {
    const timeline = buildGoalTimeline({
      project: project({ createdAt: iso(18, 5) }),
      history: [
        { kind: "step", at: iso(18, 6), label: "Build", state: "doing" },
        { kind: "step", at: iso(18, 7), label: "Build", state: "todo" },
        { kind: "replanned", at: iso(18, 8), steps: 3 },
      ],
      tasks: [],
      botName,
    });
    expect(timeline.map((entry) => entry.text)).toEqual([
      "Plan changed · 3 steps",
      "Step reopened · Build",
      "Step started · Build",
      "Goal opened by Poteto.",
    ]);
  });

  it("names failed, stopped and cancelled tasks, and a done or dropped goal", () => {
    const closed = buildGoalTimeline({
      project: project({
        createdAt: iso(18, 5),
        state: { kind: "done", closedAt: iso(22, 0) },
      }),
      history: [],
      tasks: [
        task({ id: "failed", status: "failed", startedAt: iso(19, 0), updatedAt: iso(19, 20) }),
        task({
          id: "stopped",
          status: "interrupted",
          startedAt: iso(19, 5),
          updatedAt: iso(19, 30),
        }),
        task({
          id: "cancelled",
          status: "cancelled",
          startedAt: null,
          updatedAt: iso(19, 40),
        }),
      ],
      botName,
    });
    expect(closed.map((entry) => entry.text)).toEqual([
      "Goal done.",
      "Developer cancelled · Build the goal sheet",
      "Developer stopped · Build the goal sheet",
      "Developer failed · Build the goal sheet",
      "Developer started · Build the goal sheet",
      "Developer started · Build the goal sheet",
      "Goal opened by Poteto.",
    ]);

    const dropped = buildGoalTimeline({
      project: project({
        createdAt: iso(18, 5),
        state: { kind: "dropped", closedAt: iso(22, 0) },
      }),
      history: [],
      tasks: [],
      botName,
    });
    expect(dropped[0]?.text).toBe("Goal dropped.");
  });

  it("a queued task that never started has no started line", () => {
    const timeline = buildGoalTimeline({
      project: project({ createdAt: iso(18, 5) }),
      history: [],
      tasks: [task({ id: "queued", status: "queued", startedAt: null, updatedAt: iso(19, 0) })],
      botName,
    });
    expect(timeline.map((entry) => entry.text)).toEqual(["Goal opened by Poteto."]);
  });
});

describe("goalTimelineTime", () => {
  it("reads h:mm today and Mon h:mm on an earlier day", () => {
    const today = local(21, 10).getTime();
    const yesterday = new Date(2026, 10, 13, 9, 5, 0, 0).getTime();
    expect(goalTimelineTime(today, local(22, 0).getTime())).toBe("21:10");
    expect(goalTimelineTime(yesterday, local(22, 0).getTime())).toBe("Fri 9:05");
  });
});
