import type { PersonalProject, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildRunningView, taskNowLine } from "./nowLine.ts";
import { buildProjectCards } from "./projectCards.ts";
import { buildWorkNow, buildWorkTimeline, type WorkChatTurn } from "./workTimeline.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => DateTime.makeUnsafe(new Date(ms).toISOString());

const NAMES: Record<string, string> = {
  builder: "Builder",
  developer: "Developer",
  researcher: "Researcher",
  poteto: "Poteto",
};
const botName = (botId: string) => NAMES[botId] ?? botId;

function goal(id: string, closed?: "done" | "dropped"): PersonalProject {
  return {
    projectId: id,
    leadBotId: "poteto",
    threadId: "thread-poteto",
    name: `Goal ${id}`,
    steps: [{ label: "Build", state: "doing" }],
    estimate: null,
    state: closed === undefined ? { kind: "open" } : { kind: closed, closedAt: iso(NOW - HOUR) },
    lastActivityAt: iso(NOW - 10 * MIN),
    createdAt: iso(NOW - 5 * HOUR),
    updatedAt: iso(NOW - 10 * MIN),
  } as unknown as PersonalProject;
}

function task(input: {
  readonly id: string;
  readonly status: PersonalTask["status"];
  readonly botId?: string;
  readonly projectId?: string;
  readonly parentTaskId?: string;
  readonly createdAgoMs?: number;
  readonly startedAgoMs?: number | null;
  readonly availableAt?: number;
}): PersonalTask {
  const createdAgoMs = input.createdAgoMs ?? 30 * MIN;
  const startedAgoMs = input.startedAgoMs === undefined ? createdAgoMs : input.startedAgoMs;
  return {
    taskId: input.id,
    rootTaskId: input.parentTaskId ?? input.id,
    parentTaskId: input.parentTaskId ?? null,
    botId: input.botId ?? "builder",
    threadId: `thread-${input.id}`,
    title: `Task ${input.id}`,
    status: input.status,
    source: "delegation",
    idempotencyKey: `key-${input.id}`,
    depth: input.parentTaskId === undefined ? 0 : 1,
    result: null,
    availableAt: input.availableAt === undefined ? null : iso(input.availableAt),
    createdAt: iso(NOW - createdAgoMs),
    updatedAt: iso(NOW - Math.min(createdAgoMs, startedAgoMs ?? createdAgoMs)),
    startedAt: startedAgoMs === null ? null : iso(NOW - startedAgoMs),
    completedAt: null,
    projectId: input.projectId ?? null,
  } as unknown as PersonalTask;
}

const chatTurn: WorkChatTurn = {
  threadId: "c1",
  turnId: "turn-c1",
  botId: "poteto",
  title: "Plan the week",
  startedMs: NOW - 2 * MIN,
  endedMs: null,
  needsYou: false,
};

function view(input: {
  readonly projects: ReadonlyArray<PersonalProject>;
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly chats?: ReadonlyArray<WorkChatTurn>;
  readonly notes?: ReadonlyMap<string, string>;
}) {
  const timeline = buildWorkTimeline({
    tasks: input.tasks,
    chats: input.chats ?? [],
    botIds: Object.keys(NAMES),
    nowMs: NOW,
    rangeMs: 4 * HOUR,
  });
  const now = buildWorkNow(timeline);
  const running = buildRunningView({
    now,
    tasks: new Map(input.tasks.map((entry) => [entry.taskId as string, entry] as const)),
    summary: buildProjectCards({
      projects: input.projects,
      tasks: input.tasks,
      nowMs: NOW,
      botName,
    }),
    notes: input.notes ?? new Map(),
    chatTitles: new Map(),
    botName,
    nowMs: NOW,
  });
  return { now, running };
}

const rowsOf = (running: ReturnType<typeof buildRunningView>, projectId: string) =>
  (running.rowsByProject.get(projectId) ?? []).map((row) => ({
    taskId: row.bar.taskId,
    label: row.now.label,
    line: row.now.line,
  }));

const looseIds = (running: ReturnType<typeof buildRunningView>) =>
  running.loose.flatMap((row) => [row.lead.id, ...row.helpers.map((bar) => bar.id)]).toSorted();

describe("buildRunningView", () => {
  const tasks = [
    task({ id: "t1", status: "running", projectId: "A", startedAgoMs: 4 * MIN }),
    task({ id: "t0", status: "queued", createdAgoMs: 20 * MIN, startedAgoMs: null }),
    task({
      id: "t2",
      status: "queued",
      projectId: "A",
      createdAgoMs: 10 * MIN,
      startedAgoMs: null,
    }),
  ];

  it("nests live work under its goal with a now-line and keeps the rest under Not in a goal", () => {
    const { running } = view({
      projects: [goal("A"), goal("B")],
      tasks,
      chats: [chatTurn],
      notes: new Map([["thread-t1", "Building the APK"]]),
    });
    expect(rowsOf(running, "A")).toEqual([
      { taskId: "t1", label: "Working · 4 min", line: "Building the APK" },
      { taskId: "t2", label: "Queued · 2nd in line", line: "Task t2" },
    ]);
    expect(rowsOf(running, "B")).toEqual([]);
    expect(looseIds(running)).toEqual(["chat:c1", "task:t0"]);
    expect(running.looseHeader).toBe("Not in a goal · 2");
  });

  it("with no goals reads Running now and keeps today's rows", () => {
    const { now, running } = view({ projects: [], tasks, chats: [chatTurn] });
    expect(running.looseHeader).toBe("Running now");
    expect(running.loose).toEqual(now.running);
    expect(running.rowsByProject.size).toBe(0);
  });

  it("puts work of a goal closed done under Not in a goal", () => {
    const { running } = view({
      projects: [goal("A"), goal("Z", "done")],
      tasks: [task({ id: "t1", status: "running", projectId: "Z", startedAgoMs: 4 * MIN })],
    });
    expect(rowsOf(running, "Z")).toEqual([]);
    expect(looseIds(running)).toEqual(["task:t1"]);
    expect(running.looseHeader).toBe("Not in a goal · 1");
  });

  it("a lead waiting on its helpers names them", () => {
    const { running } = view({
      projects: [goal("A")],
      tasks: [
        task({ id: "p", status: "waiting_for_agent", botId: "poteto", projectId: "A" }),
        task({
          id: "c-dev",
          status: "running",
          botId: "developer",
          projectId: "A",
          parentTaskId: "p",
        }),
        task({
          id: "c-res",
          status: "running",
          botId: "researcher",
          projectId: "A",
          parentTaskId: "p",
        }),
      ],
    });
    const parent = rowsOf(running, "A").find((row) => row.taskId === "p");
    expect(parent?.line).toBe("Waiting on Developer, Researcher");
  });
});

describe("taskNowLine", () => {
  it("a usage-limited task says when it resumes, on the local clock", () => {
    const resumes = new Date(2026, 10, 14, 21, 40).getTime();
    const limited = task({ id: "r", status: "rate_limited", availableAt: resumes });
    expect(
      taskNowLine({
        task: limited,
        note: undefined,
        title: "Task r",
        childBotNames: [],
        queuePosition: null,
        nowMs: NOW,
      }),
    ).toEqual({ label: "Paused", line: "Usage limit · resumes 9:40" });
  });
});
