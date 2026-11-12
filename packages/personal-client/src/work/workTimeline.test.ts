import type { PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  barGeometry,
  buildWorkTimeline,
  timelineTicks,
  workInitiatorLabel,
  workRangeMs,
  workTickLabel,
  type WorkChatTurn,
} from "./workTimeline.ts";

const at = (clock: string) => `2026-11-12T${clock}:00.000Z`;
const msAt = (clock: string) => Date.parse(at(clock));
const NOW = msAt("12:00");
const HOUR = 60 * 60_000;

function task(input: {
  readonly taskId: string;
  readonly rootTaskId?: string;
  readonly parentTaskId?: string;
  readonly botId?: string;
  readonly status?: PersonalTask["status"];
  readonly source?: PersonalTask["source"];
  readonly depth?: number;
  readonly title?: string;
  readonly started?: string | null;
  readonly updated?: string;
  readonly completed?: string;
  readonly threadId?: string | null;
  readonly key?: string;
  readonly backgroundSince?: string;
}): PersonalTask {
  const started = input.started === undefined ? "11:00" : input.started;
  return {
    taskId: input.taskId,
    rootTaskId: input.rootTaskId ?? input.taskId,
    parentTaskId: input.parentTaskId ?? null,
    botId: input.botId ?? "lead",
    threadId: input.threadId === undefined ? `thread-${input.taskId}` : input.threadId,
    title: input.title ?? `Task ${input.taskId}`,
    status: input.status ?? "running",
    source: input.source ?? "user",
    idempotencyKey: input.key ?? `key-${input.taskId}`,
    depth: input.depth ?? 0,
    result:
      input.backgroundSince === undefined
        ? null
        : { summary: "", waitingOnBackgroundSince: at(input.backgroundSince) },
    createdAt: DateTime.makeUnsafe(at(started ?? "11:00")),
    updatedAt: DateTime.makeUnsafe(at(input.updated ?? input.completed ?? started ?? "11:00")),
    startedAt: started === null ? null : DateTime.makeUnsafe(at(started)),
    completedAt: input.completed === undefined ? null : DateTime.makeUnsafe(at(input.completed)),
  } as unknown as PersonalTask;
}

const build = (
  tasks: ReadonlyArray<PersonalTask>,
  chats: ReadonlyArray<WorkChatTurn> = [],
  rangeMs = 4 * HOUR,
) =>
  buildWorkTimeline({
    tasks,
    chats,
    botIds: ["lead", "builder", "shipper", "idle"],
    nowMs: NOW,
    rangeMs,
  });

describe("buildWorkTimeline", () => {
  it("groups a request with its helpers and indents them", () => {
    const timeline = build([
      task({ taskId: "root", title: "Ship the release", status: "waiting_for_agent" }),
      task({
        taskId: "child",
        rootTaskId: "root",
        parentTaskId: "root",
        botId: "shipper",
        source: "delegation",
        depth: 1,
        started: "11:30",
      }),
    ]);
    expect(timeline.groups).toHaveLength(1);
    const [group] = timeline.groups;
    expect(group?.initiator).toEqual({ kind: "you", title: "Ship the release" });
    expect(group?.lanes.map((lane) => [lane.botId, lane.depth])).toEqual([
      ["lead", 0],
      ["shipper", 1],
    ]);
    expect(group?.lanes[0]?.bars[0]?.tone).toBe("waitingOthers");
    expect(group?.lanes[1]?.bars[0]?.tone).toBe("working");
    expect(timeline.idleBotIds).toEqual(["builder", "idle"]);
  });

  it("names a routine as the initiator", () => {
    const timeline = build([task({ taskId: "r", source: "routine", title: "Tennis Friday" })]);
    expect(workInitiatorLabel(timeline.groups[0]!.initiator)).toBe(
      "Started by Tennis Friday · routine",
    );
  });

  it("reports a root it was not given and never invents the initiator", () => {
    const timeline = build([
      task({ taskId: "child", rootTaskId: "gone", parentTaskId: "gone", source: "delegation" }),
    ]);
    expect(timeline.missingRootIds).toEqual(["gone"]);
    expect(timeline.groups[0]?.initiator).toEqual({ kind: "unknown" });
    expect(workInitiatorLabel({ kind: "unknown" })).toBe("Started earlier");
  });

  it("lists work that waits for the owner and puts its group first", () => {
    const timeline = build([
      task({ taskId: "busy", started: "11:50" }),
      task({ taskId: "ask", status: "waiting_for_user", started: "10:00", updated: "10:40" }),
    ]);
    expect(timeline.groups.map((group) => group.key)).toEqual(["task:ask", "task:busy"]);
    expect(timeline.needs.map((bar) => bar.taskId)).toEqual(["ask"]);
    expect(timeline.needs[0]?.waitSinceMs).toBe(msAt("10:40"));
  });

  it("uses the background wait time while a running task waits", () => {
    const timeline = build([task({ taskId: "bg", backgroundSince: "11:20" })]);
    const bar = timeline.groups[0]?.lanes[0]?.bars[0];
    expect(bar?.tone).toBe("waitingOthers");
    expect(bar?.waitSinceMs).toBe(msAt("11:20"));
  });

  it("keeps finished work inside the window and drops older work", () => {
    const timeline = build([
      task({ taskId: "old", status: "completed", started: "06:00", completed: "07:00" }),
      task({ taskId: "recent", status: "failed", started: "09:00", completed: "09:30" }),
      task({ taskId: "stopped", status: "cancelled", started: "10:00", completed: "10:05" }),
    ]);
    expect(timeline.groups.map((group) => group.key)).toEqual(["task:stopped", "task:recent"]);
    expect(timeline.groups.map((group) => group.lanes[0]?.bars[0]?.tone)).toEqual([
      "stopped",
      "failed",
    ]);
  });

  it("always shows queued work", () => {
    const timeline = build([task({ taskId: "q", status: "queued", started: null })]);
    expect(timeline.groups[0]?.lanes[0]?.bars[0]?.tone).toBe("queued");
    expect(timeline.groups[0]?.active).toBe(true);
  });

  it("draws a plain chat turn once, unless a task stands for it", () => {
    const chat: WorkChatTurn = {
      threadId: "t1",
      turnId: "turn1",
      botId: "builder",
      title: "Fix the widget",
      startedMs: msAt("11:40"),
      endedMs: null,
      needsYou: false,
    };
    const alone = build([], [chat]);
    expect(alone.groups[0]?.initiator).toEqual({ kind: "you", title: "Fix the widget" });
    expect(alone.groups[0]?.lanes[0]?.bars[0]?.id).toBe("chat:t1");

    const adopted = build([task({ taskId: "a", key: "thread-turn:t1:turn1" })], [chat]);
    expect(adopted.groups.map((group) => group.key)).toEqual(["task:a"]);

    const sameThread = build([task({ taskId: "b", threadId: "t1" })], [chat]);
    expect(sameThread.groups.map((group) => group.key)).toEqual(["task:b"]);
  });

  it("marks a chat that waits for an answer", () => {
    const timeline = build(
      [],
      [
        {
          threadId: "t2",
          turnId: null,
          botId: "lead",
          title: "Which one?",
          startedMs: msAt("11:00"),
          endedMs: msAt("11:10"),
          needsYou: true,
        },
      ],
    );
    const bar = timeline.needs[0];
    expect(bar?.tone).toBe("needsYou");
    expect(bar?.endMs).toBeNull();
    expect(bar?.waitSinceMs).toBe(msAt("11:10"));
  });
});

describe("barGeometry", () => {
  const window = { startMs: msAt("08:00"), nowMs: NOW };

  it("places a running bar up to the now line", () => {
    const timeline = build([task({ taskId: "x", started: "10:00" })]);
    const geometry = barGeometry(timeline.groups[0]!.lanes[0]!.bars[0]!, window, 0.8);
    expect(geometry.left).toBeCloseTo(0.4);
    expect(geometry.width).toBeCloseTo(0.4);
    expect(geometry.workedShare).toBe(1);
    expect(geometry.clippedStart).toBe(false);
  });

  it("splits a waiting bar at the wait time and clips an early start", () => {
    const timeline = build([
      task({ taskId: "w", status: "waiting_for_user", started: "06:00", updated: "10:00" }),
    ]);
    const geometry = barGeometry(timeline.groups[0]!.lanes[0]!.bars[0]!, window, 1);
    expect(geometry.left).toBe(0);
    expect(geometry.width).toBe(1);
    expect(geometry.workedShare).toBeCloseTo(0.5);
    expect(geometry.clippedStart).toBe(true);
  });

  it("puts queued work right of the now line", () => {
    const timeline = build([task({ taskId: "q", status: "queued", started: null })]);
    const geometry = barGeometry(timeline.groups[0]!.lanes[0]!.bars[0]!, window, 0.8);
    expect(geometry.left).toBe(0.8);
    expect(geometry.width).toBeCloseTo(0.2);
  });
});

describe("ranges and ticks", () => {
  it("spaces ticks evenly and ends at now", () => {
    expect(timelineTicks({ startMs: 0, nowMs: 400 }, 4)).toEqual([0, 100, 200, 300, 400]);
  });

  it("gives fixed ranges and at least an hour for today", () => {
    expect(workRangeMs("1h", NOW)).toBe(HOUR);
    expect(workRangeMs("4h", NOW)).toBe(4 * HOUR);
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    expect(workRangeMs("today", midnight.getTime() + 60_000)).toBe(HOUR);
  });

  it("labels a tick with a short local clock", () => {
    expect(workTickLabel(new Date(2026, 10, 12, 17, 5).getTime())).toBe("5:05");
    expect(workTickLabel(new Date(2026, 10, 12, 0, 30).getTime())).toBe("12:30");
  });
});
