import type { PersonalProject, PersonalProjectStep, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildProjectCards } from "./projectCards.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => DateTime.makeUnsafe(new Date(ms).toISOString());

const NAMES: Record<string, string> = {
  poteto: "Poteto",
  builder: "Builder",
  verifier: "Verifier 2",
  shipper: "Shipper",
};
const botName = (botId: string) => NAMES[botId] ?? botId;

const FIVE_STEPS: ReadonlyArray<PersonalProjectStep> = [
  { label: "Design", state: "done" },
  { label: "Build", state: "done" },
  { label: "Verify on emulator", state: "doing" },
  { label: "Release", state: "todo" },
  { label: "Close out", state: "todo" },
];

function project(input: {
  readonly id: string;
  readonly name?: string;
  readonly steps?: ReadonlyArray<PersonalProjectStep>;
  readonly dueInMs?: number;
  readonly estimatedAgoMs?: number;
  readonly lastActivityAgoMs?: number;
  readonly closed?: { readonly kind: "done" | "dropped"; readonly agoMs: number };
}): PersonalProject {
  return {
    projectId: input.id,
    leadBotId: "poteto",
    threadId: "thread-poteto",
    name: input.name ?? `Project ${input.id}`,
    steps: input.steps ?? FIVE_STEPS,
    estimate:
      input.dueInMs === undefined
        ? null
        : { dueAt: iso(NOW + input.dueInMs), estimatedAt: iso(NOW - (input.estimatedAgoMs ?? 0)) },
    state:
      input.closed === undefined
        ? { kind: "open" }
        : { kind: input.closed.kind, closedAt: iso(NOW - input.closed.agoMs) },
    lastActivityAt: iso(NOW - (input.lastActivityAgoMs ?? 0)),
    createdAt: iso(NOW - 10 * HOUR),
    updatedAt: iso(NOW - (input.lastActivityAgoMs ?? 0)),
  } as unknown as PersonalProject;
}

function task(input: {
  readonly id: string;
  readonly botId: string;
  readonly status: PersonalTask["status"];
  readonly projectId?: string;
  readonly parentTaskId?: string;
  readonly updatedAgoMs?: number;
}): PersonalTask {
  return {
    taskId: input.id,
    rootTaskId: input.parentTaskId ?? input.id,
    parentTaskId: input.parentTaskId ?? null,
    botId: input.botId,
    threadId: null,
    title: input.id,
    status: input.status,
    createdAt: iso(NOW - HOUR),
    updatedAt: iso(NOW - (input.updatedAgoMs ?? 0)),
    projectId: input.projectId ?? null,
  } as unknown as PersonalTask;
}

const cardOf = (
  projects: ReadonlyArray<PersonalProject>,
  tasks: ReadonlyArray<PersonalTask> = [],
) => buildProjectCards({ projects, tasks, nowMs: NOW, botName }).cards[0]!;

describe("buildProjectCards estimate label", () => {
  it("a fresh estimate due in the future reads About 2 h left, secondary", () => {
    const card = cardOf([project({ id: "a", dueInMs: 2 * HOUR, estimatedAgoMs: 5 * MIN })]);
    expect([card.estimateLabel, card.estimateTone]).toEqual(["About 2 h left", "secondary"]);
  });

  it("under an hour left reads in minutes", () => {
    const card = cardOf([project({ id: "a", dueInMs: 25 * MIN, estimatedAgoMs: 30 * MIN })]);
    expect([card.estimateLabel, card.estimateTone]).toEqual(["About 25 min left", "secondary"]);
  });

  it("88 minutes left rounds to the nearest half hour", () => {
    const card = cardOf([project({ id: "a", dueInMs: 88 * MIN, estimatedAgoMs: 5 * MIN })]);
    expect([card.estimateLabel, card.estimateTone]).toEqual(["About 1 h 30 min left", "secondary"]);
  });

  it("2 h 20 min left rounds to 2 h 30 min", () => {
    const card = cardOf([project({ id: "a", dueInMs: 140 * MIN, estimatedAgoMs: 5 * MIN })]);
    expect(card.estimateLabel).toBe("About 2 h 30 min left");
  });

  it("an estimate 2 h old or more shows its age, tertiary", () => {
    const card = cardOf([project({ id: "a", dueInMs: HOUR, estimatedAgoMs: 3 * HOUR })]);
    expect([card.estimateLabel, card.estimateTone]).toEqual([
      "About 1 h left · est. 3 h ago",
      "tertiary",
    ]);
  });

  it("past dueAt reads Overdue by 25 min in amber", () => {
    const card = cardOf([project({ id: "a", dueInMs: -25 * MIN, estimatedAgoMs: HOUR })]);
    expect([card.estimateLabel, card.estimateTone]).toEqual(["Overdue by 25 min", "overdue"]);
  });

  it("no estimate reads No estimate yet, tertiary", () => {
    const card = cardOf([project({ id: "a" })]);
    expect([card.estimateLabel, card.estimateTone, card.estimate]).toEqual([
      "No estimate yet",
      "tertiary",
      null,
    ]);
  });
});

describe("buildProjectCards who and step lines", () => {
  it("names the working bot first, with the step under way", () => {
    const card = cardOf(
      [project({ id: "a" })],
      [
        task({ id: "lead", botId: "poteto", status: "waiting_for_agent", projectId: "a" }),
        task({
          id: "verify",
          botId: "verifier",
          status: "running",
          projectId: "a",
          parentTaskId: "lead",
        }),
      ],
    );
    expect([card.whoLine, card.whoTone, card.whoBotId, card.stepLine]).toEqual([
      "Verifier 2 working",
      "working",
      "verifier",
      "Step 3 of 5 · Verify on emulator",
    ]);
    expect(card.segments).toEqual(["done", "done", "doing", "todo", "todo"]);
  });

  it("a lead waiting on a helper reads Poteto waiting on Builder", () => {
    const card = cardOf(
      [project({ id: "a" })],
      [
        task({ id: "lead", botId: "poteto", status: "waiting_for_agent", projectId: "a" }),
        task({
          id: "build",
          botId: "builder",
          status: "queued",
          projectId: "a",
          parentTaskId: "lead",
        }),
      ],
    );
    expect([card.whoLine, card.whoTone]).toEqual(["Poteto waiting on Builder", "waiting"]);
  });

  it("with no active linked task reads Nobody on it and how long it has been quiet", () => {
    const card = cardOf(
      [project({ id: "a", lastActivityAgoMs: 3 * HOUR })],
      [
        task({
          id: "old",
          botId: "builder",
          status: "completed",
          projectId: "a",
          updatedAgoMs: 2 * HOUR,
        }),
      ],
    );
    expect([card.whoLine, card.whoTone, card.whoBotId]).toEqual([
      "Nobody on it · quiet 2 h",
      "idle",
      null,
    ]);
  });

  it("all steps done reads All 5 steps done; a gap with nothing under way counts what is done", () => {
    const allDone = FIVE_STEPS.map((step) => ({ ...step, state: "done" as const }));
    const gap = FIVE_STEPS.map((step, index) => ({
      ...step,
      state: index < 2 ? ("done" as const) : ("todo" as const),
    }));
    expect(cardOf([project({ id: "a", steps: allDone })]).stepLine).toBe("All 5 steps done");
    expect(cardOf([project({ id: "a", steps: gap })]).stepLine).toBe("2 of 5 steps done");
  });

  it("a task of another project or none never counts", () => {
    const card = cardOf(
      [project({ id: "a", lastActivityAgoMs: HOUR })],
      [
        task({ id: "x", botId: "builder", status: "running", projectId: "b" }),
        task({ id: "y", botId: "shipper", status: "running" }),
      ],
    );
    expect(card.whoLine).toBe("Nobody on it · quiet 1 h");
    expect(card.activeTaskIds).toEqual([]);
  });
});

describe("buildProjectCards folds", () => {
  it("shows 4 cards, counts the rest, folds 72 h quiet projects and lists closed ones", () => {
    const summary = buildProjectCards({
      projects: [
        ...["a", "b", "c", "d", "e"].map((id, index) =>
          project({ id, lastActivityAgoMs: (index + 1) * HOUR }),
        ),
        project({ id: "sleepy", lastActivityAgoMs: 72 * HOUR }),
        project({ id: "shipped", closed: { kind: "done", agoMs: 2 * HOUR } }),
        project({ id: "stopped", closed: { kind: "dropped", agoMs: 26 * HOUR } }),
      ],
      tasks: [task({ id: "t", botId: "builder", status: "running", projectId: "e" })],
      nowMs: NOW,
      botName,
    });
    expect(summary.cards.map((card) => card.projectId)).toEqual(["e", "a", "b", "c"]);
    expect(summary.more.map((card) => card.projectId)).toEqual(["d"]);
    expect(summary.quiet.map((card) => card.projectId)).toEqual(["sleepy"]);
    expect(summary.closed.map((entry) => [entry.projectId, entry.outcome])).toEqual([
      ["shipped", "done"],
      ["stopped", "dropped"],
    ]);
  });

  it("never folds a goal with live work behind +N more", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const summary = buildProjectCards({
      projects: ids.map((id, index) => project({ id, lastActivityAgoMs: (index + 1) * HOUR })),
      tasks: ids.map((id) =>
        task({ id: `t-${id}`, botId: "builder", status: "running", projectId: id }),
      ),
      nowMs: NOW,
      botName,
    });
    expect(summary.cards.length).toBe(5);
    expect(summary.more.length).toBe(0);
  });

  it("an overdue idle goal sorts before idle goals so it never folds behind +N more", () => {
    const summary = buildProjectCards({
      projects: [
        project({ id: "live-a", lastActivityAgoMs: 4 * HOUR }),
        project({ id: "live-b", lastActivityAgoMs: 3 * HOUR }),
        project({
          id: "late",
          dueInMs: -2 * HOUR,
          estimatedAgoMs: 5 * HOUR,
          lastActivityAgoMs: 10 * HOUR,
        }),
        project({ id: "fresh", lastActivityAgoMs: HOUR }),
        project({ id: "older", lastActivityAgoMs: 2 * HOUR }),
      ],
      tasks: [
        task({
          id: "t-a",
          botId: "builder",
          status: "running",
          projectId: "live-a",
          updatedAgoMs: 4 * HOUR,
        }),
        task({
          id: "t-b",
          botId: "builder",
          status: "running",
          projectId: "live-b",
          updatedAgoMs: 3 * HOUR,
        }),
      ],
      nowMs: NOW,
      botName,
    });
    expect(summary.cards.map((card) => card.projectId)).toEqual([
      "live-b",
      "live-a",
      "late",
      "fresh",
    ]);
    expect(summary.more.map((card) => card.projectId)).toEqual(["older"]);
  });

  it("no projects gives nothing to draw", () => {
    expect(buildProjectCards({ projects: [], tasks: [], nowMs: NOW, botName })).toEqual({
      cards: [],
      more: [],
      quiet: [],
      closed: [],
    });
  });
});
