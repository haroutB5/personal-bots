import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTeamGroups,
  buildTeamGroupsLayout,
  delegationConnectorPath,
  deriveDelegationLinks,
  RECENT_DELEGATION_WINDOW_MS,
  teamDiagramSummary,
  type TeamDiagramPoint,
} from "./teamDiagramModel";

/** The phone geometry TeamScreen actually renders with. */
const LAYOUT = {
  width: 350,
  leadSize: 72,
  nodeSize: 64,
  gapX: 32,
  gapY: 80,
  bandGap: 56,
  headingSpace: 28,
  perRow: 4,
};

const ROSTER = [
  { botId: "cto", team: "dev" as const, lead: true },
  { botId: "frontend", team: "dev" as const },
  { botId: "security", team: "dev" as const },
  { botId: "assistant", team: "assistant" as const, lead: true },
  { botId: "planner", team: "assistant" as const },
];
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

describe("buildTeamGroups", () => {
  it("splits the roster into two teams, each behind its lead", () => {
    expect(buildTeamGroups(ROSTER)).toEqual([
      {
        team: "dev",
        label: "Dev team",
        leadBotId: "cto",
        memberBotIds: ["frontend", "security"],
      },
      {
        team: "assistant",
        label: "Assistant's team",
        leadBotId: "assistant",
        memberBotIds: ["planner"],
      },
    ]);
  });

  // A bot from a server too old to have teams, and a team nobody is on.
  it("defaults an unassigned bot to the assistant's team and omits the empty one", () => {
    expect(buildTeamGroups([{ botId: "scout" }])).toEqual([
      {
        team: "assistant",
        label: "Assistant's team",
        leadBotId: null,
        memberBotIds: ["scout"],
      },
    ]);
  });
});

describe("buildTeamGroupsLayout", () => {
  it("stacks two teams that never overlap, each lead above its own members", () => {
    const layout = buildTeamGroupsLayout(buildTeamGroups(ROSTER), LAYOUT);

    expect(layout.bands.map((band) => [band.team, band.label, band.leadBotId])).toEqual([
      ["dev", "Dev team", "cto"],
      ["assistant", "Assistant's team", "assistant"],
    ]);

    const at = (botId: string) => layout.bots.get(botId)!;
    // Leads are centred under the owner; members hang below their own lead.
    expect(at("cto").x).toBe(layout.owner.x);
    expect(at("assistant").x).toBe(layout.owner.x);
    expect(at("cto").y).toBeLessThan(at("frontend").y);
    expect(at("assistant").y).toBeLessThan(at("planner").y);
    // The dev band closes before the assistant's opens, so the two groups
    // read as two groups rather than one run of avatars.
    expect(layout.bands[0]!.bottom).toBeLessThanOrEqual(layout.bands[1]!.top);
    expect(at("frontend").y).toBeLessThan(at("assistant").y);
    // Every bot is placed, and the canvas covers the lowest one.
    expect([...layout.bots.keys()].toSorted()).toEqual(ROSTER.map((bot) => bot.botId).toSorted());
    expect(layout.svgHeight).toBeGreaterThan(at("planner").y);
  });
});

describe("teamDiagramSummary", () => {
  it("names both teams and their leads", () => {
    const names = [
      { botId: "cto", name: "CTO" },
      { botId: "frontend", name: "Frontend" },
      { botId: "security", name: "Security" },
      { botId: "assistant", name: "Assistant" },
      { botId: "planner", name: "Planner" },
    ];

    const summary = teamDiagramSummary("Harout", buildTeamGroups(ROSTER), names, []);

    expect(summary).toContain("Dev team, led by CTO, with Frontend, Security");
    expect(summary).toContain("Assistant's team, led by Assistant, with Planner");
    expect(summary).toContain("No current or recent delegations");
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
    const layout = buildTeamGroupsLayout(
      buildTeamGroups([
        { botId: "lead", team: "dev", lead: true },
        { botId: "a", team: "dev" },
        { botId: "b", team: "dev" },
        { botId: "c", team: "dev" },
      ]),
      LAYOUT,
    );
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
