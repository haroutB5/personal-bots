import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTeamLayout,
  delegationConnectorPath,
  deriveDelegationLinks,
  RECENT_DELEGATION_WINDOW_MS,
  type TeamDiagramPoint,
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

type Segment = { readonly start: TeamDiagramPoint; readonly end: TeamDiagramPoint };

/** Reads back the endpoints of an `M x y Q cx cy ex ey` path. */
function endpointsOf(path: string): Segment {
  const numbers = path.match(/-?[\d.]+/g)?.map(Number);
  if (numbers?.length !== 6) throw new Error(`unexpected path: ${path}`);
  const [startX, startY, , , endX, endY] = numbers as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { start: { x: startX, y: startY }, end: { x: endX, y: endY } };
}

const distanceBetween = (a: TeamDiagramPoint, b: TeamDiagramPoint) =>
  Math.hypot(b.x - a.x, b.y - a.y);

/** Apex of the quadratic, i.e. the point at t = 0.5. */
function apexOf(path: string): TeamDiagramPoint {
  const numbers = path.match(/-?[\d.]+/g)?.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [startX, startY, controlX, controlY, endX, endY] = numbers;
  return {
    x: 0.25 * startX + 0.5 * controlX + 0.25 * endX,
    y: 0.25 * startY + 0.5 * controlY + 0.25 * endY,
  };
}

describe("delegationConnectorPath", () => {
  it("leaves both nodes radially and bows clear of the labels", () => {
    expect(delegationConnectorPath({ x: 100, y: 100 }, { x: 300, y: 100 }, 64)).toBe(
      "M 129.44 79.28 Q 200 29.6 265.66 75.82",
    );
    expect(delegationConnectorPath({ x: 100, y: 100 }, { x: 100, y: 100 }, 64)).toBe("");
  });

  it("stays visible between adjacent columns instead of hiding under the avatars", () => {
    // The real phone geometry: TeamScreen lays out 64-unit nodes with gapX 32,
    // so neighbours are 96 units apart, and each node's opaque `w-24` label
    // column is exactly that wide — neighbouring columns tile with no seam, so
    // anything drawn at or below `y - nodeSize / 2` is masked. The old straight
    // edge-to-edge inset left an 18-unit stub, entirely inside that mask.
    const layout = buildTeamLayout(["a", "b", "c"], {
      width: 350,
      nodeSize: 64,
      gapX: 32,
      gapY: 80,
      perRow: 4,
    });
    const a = layout.bots.get("a")!;
    const b = layout.bots.get("b")!;
    expect(distanceBetween(a, b)).toBe(96);

    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const path = delegationConnectorPath(from, to, 64);
      const { start, end } = endpointsOf(path);

      // Visible run between the two nodes, not a stub.
      expect(distanceBetween(start, end)).toBeGreaterThanOrEqual(40);
      // Neither endpoint is swallowed by a node it is meant to connect.
      for (const point of [start, end]) {
        expect(distanceBetween(point, a)).toBeGreaterThanOrEqual(32);
        expect(distanceBetween(point, b)).toBeGreaterThanOrEqual(32);
      }
      // The arc clears the label columns: its apex sits above the top edge of
      // the node boxes, in the open band under the owner, either way round.
      expect(apexOf(path).y).toBeLessThan(a.y - 32);
    }
  });

  it("keeps endpoints one silhouette clear of both node centres at any spacing", () => {
    for (const gap of [0, 16, 32, 64, 160]) {
      const from = { x: 0, y: 0 };
      const to = { x: 64 + gap, y: 0 };
      const { start, end } = endpointsOf(delegationConnectorPath(from, to, 64));
      // Outside the 32-unit silhouette, and never further out than the
      // nominal clearance (36 at the tail, 42 at the arrow head).
      expect(distanceBetween(start, from)).toBeGreaterThanOrEqual(32);
      expect(distanceBetween(start, from)).toBeLessThanOrEqual(36.05);
      expect(distanceBetween(end, to)).toBeGreaterThanOrEqual(32);
      expect(distanceBetween(end, to)).toBeLessThanOrEqual(42.05);
      // The arrow head still travels forwards, never backwards.
      expect(end.x).toBeGreaterThan(start.x);
    }
  });
});
