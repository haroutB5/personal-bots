import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTeamLayout,
  delegationConnectorPath,
  deriveDelegationLinks,
  RECENT_DELEGATION_WINDOW_MS,
} from "./teamDiagramModel";

const OPTIONS = { width: 400, nodeSize: 64, gapX: 24, gapY: 80, perRow: 4 };
const decodeTask = Schema.decodeUnknownSync(PersonalTask);
const NOW = Date.parse("2026-09-14T12:00:00.000Z");

function task(overrides: Record<string, unknown>) {
  return decodeTask({
    taskId: "root",
    rootTaskId: "root",
    parentTaskId: null,
    botId: "assistant",
    threadId: "thread-root",
    title: "Root",
    objective: "Do it",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "running",
    source: "user",
    idempotencyKey: `key-${String(overrides.taskId ?? "root")}`,
    depth: 0,
    maxDepth: 2,
    maxChildren: 4,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  });
}

describe("buildTeamLayout", () => {
  it("centers one bot below the owner", () => {
    const layout = buildTeamLayout(["a"], OPTIONS);
    expect(layout.owner).toEqual({ x: 200, y: 32 });
    expect(layout.bots.get("a")).toEqual({ x: 200, y: 176, row: 0, column: 0 });
    expect(layout.rows).toEqual([["a"]]);
    expect(layout.svgHeight).toBe(256);
  });

  it("centers a row of three bots", () => {
    const layout = buildTeamLayout(["a", "b", "c"], OPTIONS);
    expect([...layout.bots.values()].map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 112, y: 176 },
      { x: 200, y: 176 },
      { x: 288, y: 176 },
    ]);
  });

  it("wraps eight bots into two centered rows of four", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const layout = buildTeamLayout(ids, OPTIONS);
    expect(layout.rows).toEqual([
      ["a", "b", "c", "d"],
      ["e", "f", "g", "h"],
    ]);
    expect(layout.bots.get("a")).toMatchObject({ x: 68, y: 176, row: 0 });
    expect(layout.bots.get("d")).toMatchObject({ x: 332, y: 176, row: 0 });
    expect(layout.bots.get("e")).toMatchObject({ x: 68, y: 320, row: 1 });
    expect(layout.bots.get("h")).toMatchObject({ x: 332, y: 320, row: 1 });
    expect(layout.svgHeight).toBe(400);
  });
});

describe("deriveDelegationLinks", () => {
  const botIds = new Set(["assistant", "developer", "researcher"]);
  const root = task({ taskId: "root", botId: "assistant" });

  it("excludes self-links and bots outside the team", () => {
    const links = deriveDelegationLinks(
      [
        root,
        task({ taskId: "self", parentTaskId: "root", botId: "assistant" }),
        task({ taskId: "unknown", parentTaskId: "root", botId: "deleted-bot" }),
      ],
      botIds,
      NOW,
    );
    expect(links).toEqual([]);
  });

  it("dedupes repeated pairs and lets running work win", () => {
    const links = deriveDelegationLinks(
      [
        root,
        task({
          taskId: "done",
          parentTaskId: "root",
          botId: "developer",
          status: "completed",
          completedAt: "2026-09-13T12:00:00.000Z",
        }),
        task({ taskId: "live", parentTaskId: "root", botId: "developer", status: "queued" }),
      ],
      botIds,
      NOW,
    );
    expect(links).toEqual([{ from: "assistant", to: "developer", state: "running" }]);
  });

  it("keeps terminal links for seven days, then drops them", () => {
    const recent = new Date(NOW - RECENT_DELEGATION_WINDOW_MS + 1).toISOString();
    const stale = new Date(NOW - RECENT_DELEGATION_WINDOW_MS - 1).toISOString();
    const links = deriveDelegationLinks(
      [
        root,
        task({
          taskId: "recent",
          parentTaskId: "root",
          botId: "developer",
          status: "completed",
          completedAt: recent,
        }),
        task({
          taskId: "stale",
          parentTaskId: "root",
          botId: "researcher",
          status: "failed",
          completedAt: stale,
        }),
      ],
      botIds,
      NOW,
    );
    expect(links).toEqual([{ from: "assistant", to: "developer", state: "recent" }]);
  });
});

describe("delegationConnectorPath", () => {
  it("starts and ends outside node silhouettes and bends directionally", () => {
    expect(delegationConnectorPath({ x: 100, y: 100 }, { x: 300, y: 100 }, 64)).toBe(
      "M 136 100 Q 197 136 258 100",
    );
    expect(delegationConnectorPath({ x: 100, y: 100 }, { x: 100, y: 100 }, 64)).toBe("");
  });
});
