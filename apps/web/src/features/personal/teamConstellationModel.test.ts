import { PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { TeamDropBot } from "./teamDiagramModel";
import { buildTeamGroups } from "./teamDiagramModel";
import {
  applyTeamUpdate,
  buildConstellationLayout,
  deriveDelegationCounts,
  deriveWorkingNow,
  formatWorkingFor,
  historyReachesCutoff,
  layoutCollisions,
  leadConfirmCopy,
  MAX_ORBIT_NODES,
  nodeLabel,
  planDrop,
  replacedLead,
  spokeIsClear,
  hubBoxes,
  spokeLine,
  spokeWidth,
  teamMoveTargets,
  undoMessage,
  undoPlan,
  workingNowTarget,
  zoneIdAtPoint,
  type NodeLabel,
} from "./teamConstellationModel";

const NAMES = [
  "IT",
  "Musey",
  "Sync reports",
  "Frontend",
  "CFO scheduler",
  "Quarterly budget planner",
  "QA",
  "Invoice reconciliation",
  "Astra",
  "Security",
  "Updates",
  "Designer",
  "Subscription tracker",
  "Payroll scheduler",
  "DevOps",
  "Backend",
  "Cashflow forecaster",
  "Ledger archivist",
  "Planner",
  "Scout",
  "Scheduler",
  "Assistant",
  "Vendor onboarding",
  "Currency converter",
  "Tax compliance checker",
];
const labels = (count: number): NodeLabel[] =>
  Array.from({ length: count }, (_, index) => nodeLabel(NAMES[index % NAMES.length]!));

describe("nodeLabel", () => {
  it("keeps a short name on one line, as wide as the name", () => {
    expect(nodeLabel("QA")).toMatchObject({ lines: 1 });
    expect(nodeLabel("QA").width).toBeLessThan(nodeLabel("Frontend").width);
    expect(nodeLabel("Sync reports")).toMatchObject({ lines: 1 });
  });

  it("gives a name of 13 or more characters two lines across the whole column", () => {
    expect(nodeLabel("CFO scheduler")).toEqual({ lines: 2, width: 76 });
    expect(nodeLabel("Quarterly budget planner")).toEqual({ lines: 2, width: 76 });
  });
});

describe("buildConstellationLayout", () => {
  it("never overlaps the hub or another node, at any team size or phone width", () => {
    for (const width of [320, 350, 390, 430]) {
      for (let count = 0; count <= 40; count += 1) {
        const layout = buildConstellationLayout(labels(count), width);
        expect(layoutCollisions(layout), `${String(count)} members at ${String(width)}`).toBe(0);
        // Every node stays inside the card.
        for (const slot of layout.slots) {
          expect(slot.x - 38).toBeGreaterThanOrEqual(0);
          expect(slot.x + 38).toBeLessThanOrEqual(layout.width);
          expect(slot.y - 20).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("draws a small team on one orbit and spreads a crowded one over more than one", () => {
    expect(buildConstellationLayout(labels(5), 350).orbits).toHaveLength(1);
    const crowded = buildConstellationLayout(labels(16), 350);
    expect(crowded.slots).toHaveLength(16);
    expect(crowded.hidden).toBe(0);
    expect(new Set(crowded.slots.map((slot) => slot.ring)).size).toBeGreaterThan(1);
  });

  it("draws all 15 or more members of a full team, long names included", () => {
    for (const count of [15, 17, 20]) {
      const layout = buildConstellationLayout(labels(count), 390);
      expect(layout.slots).toHaveLength(count);
      expect(layout.hidden).toBe(0);
    }
  });

  it("puts the rest behind a +N seat past the most a card draws", () => {
    const layout = buildConstellationLayout(labels(26), 350);
    expect(layout.slots).toHaveLength(MAX_ORBIT_NODES);
    // 19 members are drawn; the 20th seat says how many more there are.
    expect(layout.hidden).toBe(26 - (MAX_ORBIT_NODES - 1));
    expect(buildConstellationLayout(labels(MAX_ORBIT_NODES), 350).hidden).toBe(0);
  });

  it("centres the hub on a card with no members", () => {
    const layout = buildConstellationLayout([], 350);
    expect(layout.slots).toEqual([]);
    expect(layout.hub.x).toBe(175);
  });
});

describe("spokes", () => {
  it("starts outside the hub and stops short of the avatar, without crossing another spoke", () => {
    const hub = { x: 175, y: 120 };
    const lines = [
      { x: 175, y: 20 },
      { x: 300, y: 120 },
      { x: 175, y: 230 },
      { x: 50, y: 120 },
    ].map((slot) => spokeLine(hub, slot));
    for (const line of lines) {
      expect(line).not.toBeNull();
      expect(Math.hypot(line!.x1 - hub.x, line!.y1 - hub.y)).toBeGreaterThanOrEqual(42);
    }
    // Every spoke leaves the same centre, so two only ever meet at the hub.
    const angles = lines.map((line) => Math.atan2(line!.y2 - line!.y1, line!.x2 - line!.x1));
    expect(new Set(angles.map((angle) => angle.toFixed(3))).size).toBe(4);
  });

  it("never starts behind the lead's name pill or model label, whichever way it points", () => {
    const hub = { x: 195, y: 150 };
    let drawn = 0;
    for (const radius of [110, 140, 170]) {
      for (let degrees = 0; degrees < 360; degrees += 5) {
        const radians = (degrees * Math.PI) / 180;
        const slot = {
          x: hub.x + Math.cos(radians) * radius,
          y: hub.y + Math.sin(radians) * radius,
        };
        const line = spokeLine(hub, slot);
        if (line === null) continue;
        drawn += 1;
        // Every point along the first stretch of the line stays out of the disc, pill and label boxes.
        for (let offset = 0; offset <= 10; offset += 1) {
          const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
          const x = line.x1 + ((line.x2 - line.x1) * offset) / length;
          const y = line.y1 + ((line.y2 - line.y1) * offset) / length;
          for (const entry of hubBoxes(hub.x, hub.y)) {
            const inside =
              x > entry.x0 - 2 && x < entry.x1 + 2 && y > entry.y0 - 2 && y < entry.y1 + 2;
            expect(inside, `${degrees}° at ${radius}: (${x.toFixed(0)}, ${y.toFixed(0)})`).toBe(
              false,
            );
          }
        }
        // And it still ends short of the avatar, after it started.
        expect(Math.hypot(line.x2 - hub.x, line.y2 - hub.y)).toBeGreaterThan(
          Math.hypot(line.x1 - hub.x, line.y1 - hub.y),
        );
      }
    }
    expect(drawn).toBeGreaterThan(100);
  });

  it("starts at the ring when it points sideways or up, where nothing is in the way", () => {
    const hub = { x: 195, y: 150 };
    const sideways = spokeLine(hub, { x: 335, y: 150 });
    expect(sideways!.x1 - hub.x).toBeCloseTo(42, 0);
    const up = spokeLine(hub, { x: 195, y: 10 });
    expect(hub.y - up!.y1).toBeCloseTo(42, 0);
  });

  it("draws every spoke on a small team, and only the clear ones on a crowded card", () => {
    const small = buildConstellationLayout(labels(8), 350);
    expect(small.slots.every((_, index) => spokeIsClear(small, index))).toBe(true);
    const crowded = buildConstellationLayout(labels(20), 350);
    const clear = crowded.slots.filter((_, index) => spokeIsClear(crowded, index)).length;
    // Some run behind an inner node and are shown as a count instead; the inner ones are still drawn.
    expect(clear).toBeGreaterThan(0);
    expect(clear).toBeLessThan(crowded.slots.length);
  });

  it("is thicker for more handoffs, on a square-root scale", () => {
    expect(spokeWidth(0, 38)).toBe(0);
    expect(spokeWidth(2, 38)).toBeLessThan(spokeWidth(29, 38));
    expect(spokeWidth(38, 38)).toBe(5.75);
    expect(spokeWidth(1, 38)).toBeGreaterThan(1.25);
  });
});

describe("roster after a move", () => {
  const roster: ReadonlyArray<TeamDropBot> = [
    { botId: "cto", name: "CTO", team: "dev", lead: true },
    { botId: "frontend", name: "Frontend", team: "dev" },
    { botId: "assistant", name: "Assistant", team: "assistant", lead: true },
    { botId: "planner", name: "Planner", team: "assistant" },
  ];

  it("hands a lead seat over in the same write: never two leads", () => {
    const after = applyTeamUpdate(roster, { botId: "frontend", team: "assistant", lead: true });
    expect(after.filter((bot) => bot.team === "assistant" && bot.lead)).toEqual([
      { botId: "frontend", name: "Frontend", team: "assistant", lead: true },
    ]);
    expect(after.find((bot) => bot.botId === "assistant")?.lead).toBe(false);
    expect(after.find((bot) => bot.botId === "cto")?.lead).toBe(true);
  });
});

describe("lead confirm", () => {
  const roster: ReadonlyArray<TeamDropBot> = [
    { botId: "cto", name: "CTO", team: "dev", lead: true },
    { botId: "frontend", name: "Frontend", team: "dev" },
    { botId: "assistant", name: "Assistant", team: "assistant", lead: true },
    { botId: "planner", name: "Planner", team: "assistant" },
    { botId: "scout", name: "Scout", team: "empty-seat" },
    { botId: "cfo", name: "CFO", team: "Finance", lead: true },
  ];
  const frontend = roster[1]!;
  const openHandoffs = (botId: string) => (botId === "cto" ? 2 : 0);

  it("asks before a Lead drop replaces somebody, and sends nothing yet", () => {
    const plan = planDrop({
      bot: frontend,
      target: { kind: "lead", team: "dev" },
      roster,
      openHandoffsBy: openHandoffs,
    });
    expect(plan.kind).toBe("confirm");
    expect(plan).toMatchObject({
      replaced: { oldLeadId: "cto", oldLeadName: "CTO", openHandoffs: 2 },
      outcome: { update: { team: "dev", lead: true } },
    });
  });

  it("sends once it is confirmed", () => {
    const plan = planDrop({
      bot: frontend,
      target: { kind: "lead", team: "dev" },
      roster,
      openHandoffsBy: openHandoffs,
      confirmed: true,
    });
    expect(plan).toMatchObject({
      kind: "commit",
      outcome: { update: { team: "dev", lead: true } },
      replaced: { oldLeadName: "CTO" },
    });
  });

  it("does not ask for an empty seat, or for joining a team", () => {
    expect(
      planDrop({ bot: frontend, target: { kind: "lead", team: "empty-seat" }, roster }).kind,
    ).toBe("commit");
    expect(
      planDrop({ bot: frontend, target: { kind: "team", team: "assistant" }, roster }).kind,
    ).toBe("commit");
  });

  it("still refuses a lead who would leave a staffed team, before it asks anything", () => {
    const plan = planDrop({
      bot: roster[0]!,
      target: { kind: "lead", team: "assistant" },
      roster,
    });
    expect(plan).toEqual({
      kind: "blocked",
      message: "CTO leads the Dev team. Make someone else the lead there first, then move CTO.",
    });
  });

  it("says who stops leading, that they stay, and that their handoffs carry on", () => {
    const replaced = replacedLead(frontend, "dev", roster, openHandoffs)!;
    const copy = leadConfirmCopy({ bot: frontend, team: "dev", replaced });
    expect(copy.title).toBe("Make Frontend the Dev team lead?");
    expect(copy.lines).toEqual([
      "CTO stops leading and stays on the Dev team.",
      "CTO has 2 handoffs running; they carry on.",
    ]);
    expect(copy.confirmLabel).toBe("Make Frontend lead");
  });

  it("names the team a leading bot leaves behind", () => {
    const solo: ReadonlyArray<TeamDropBot> = [
      ...roster.filter((bot) => bot.botId !== "scout"),
      { botId: "scout", name: "Scout", team: "solo", lead: true },
    ];
    const replaced = replacedLead(solo.at(-1)!, "dev", solo)!;
    const copy = leadConfirmCopy({ bot: solo.at(-1)!, team: "dev", replaced });
    expect(copy.lines.at(-1)).toBe(
      "Scout leads solo; it will move to Dev team, and solo will have no lead.",
    );
  });

  it("offers every team as a Join and a Lead target, marking the replaced lead", () => {
    const groups = buildTeamGroups(roster);
    const rows = teamMoveTargets(frontend, groups, roster, openHandoffs);
    const dev = rows.find((row) => row.team === "dev")!;
    expect(dev).toMatchObject({ here: true, leadName: "CTO", memberCount: 1 });
    expect(dev.join.kind).toBe("none");
    expect(dev.replaces).toMatchObject({ oldLeadName: "CTO", openHandoffs: 2 });
    const empty = rows.find((row) => row.team === "empty-seat")!;
    expect(empty).toMatchObject({ here: false, replaces: null });
    expect(empty.lead.kind).toBe("update");
  });
});

describe("undo", () => {
  const roster: ReadonlyArray<TeamDropBot> = [
    { botId: "cto", name: "CTO", team: "dev", lead: true },
    { botId: "frontend", name: "Frontend", team: "dev" },
    { botId: "assistant", name: "Assistant", team: "assistant", lead: true },
    { botId: "planner", name: "Planner", team: "assistant" },
    { botId: "scout", name: "Scout", team: "solo", lead: true },
  ];

  /** Who is on which team, and who leads it: what a move can change. */
  const seats = (bots: ReadonlyArray<TeamDropBot>) =>
    bots.map((bot) => ({ id: bot.botId, team: bot.team, lead: bot.lead === true }));

  /** Runs `steps` the way the server does, one update at a time. */
  const run = (
    start: ReadonlyArray<TeamDropBot>,
    steps: ReadonlyArray<{ botId: string; team: string; lead: boolean }>,
  ) => steps.reduce((current, step) => applyTeamUpdate(current, step), start);

  it("puts a plain move back", () => {
    const frontend = roster[1]!;
    const plan = planDrop({ bot: frontend, target: { kind: "team", team: "assistant" }, roster });
    if (plan.kind !== "commit") throw new Error("expected a commit");
    const moved = applyTeamUpdate(roster, { botId: "frontend", ...plan.outcome.update });
    expect(moved.find((bot) => bot.botId === "frontend")).toMatchObject({ team: "assistant" });
    const steps = undoPlan({
      before: { botId: "frontend", team: "dev", lead: false },
      replaced: plan.replaced,
      destination: "assistant",
    });
    expect(steps).toEqual([{ botId: "frontend", team: "dev", lead: false }]);
    expect(seats(run(moved, steps))).toEqual(seats(roster));
  });

  it("gives the replaced lead their seat back before the bot returns", () => {
    const frontend = roster[1]!;
    const plan = planDrop({
      bot: frontend,
      target: { kind: "lead", team: "assistant" },
      roster,
      confirmed: true,
    });
    if (plan.kind !== "commit") throw new Error("expected a commit");
    const moved = applyTeamUpdate(roster, { botId: "frontend", ...plan.outcome.update });
    expect(
      moved.filter((bot) => bot.team === "assistant" && bot.lead).map((bot) => bot.botId),
    ).toEqual(["frontend"]);
    const steps = undoPlan({
      before: { botId: "frontend", team: "dev", lead: false },
      replaced: plan.replaced,
      destination: "assistant",
    });
    expect(steps).toEqual([
      { botId: "assistant", team: "assistant", lead: true },
      { botId: "frontend", team: "dev", lead: false },
    ]);
    // The whole roster is back the way it was.
    expect(seats(run(moved, steps))).toEqual(seats(roster));
  });

  it("returns a lead to its own team and seat", () => {
    const scout = roster[4]!;
    const plan = planDrop({ bot: scout, target: { kind: "team", team: "assistant" }, roster });
    if (plan.kind !== "commit") throw new Error("expected a commit");
    const moved = applyTeamUpdate(roster, { botId: "scout", ...plan.outcome.update });
    const steps = undoPlan({
      before: { botId: "scout", team: "solo", lead: true },
      replaced: null,
      destination: "assistant",
    });
    expect(seats(run(moved, steps))).toEqual(seats(roster));
  });

  it("says what happened", () => {
    expect(undoMessage("Frontend", "dev", false)).toBe("Frontend is back on the Dev team.");
    expect(undoMessage("CTO", "dev", true)).toBe("CTO is back as the Dev team lead.");
  });
});

describe("handoffs", () => {
  const decode = Schema.decodeUnknownSync(PersonalTask);
  const NOW = Date.parse("2026-09-29T12:00:00.000Z");
  const task = (overrides: Record<string, unknown>) =>
    decode({
      taskId: "t",
      rootTaskId: "root",
      parentTaskId: "root",
      botId: "backend",
      threadId: "thread-1",
      title: "Do it",
      objective: "x",
      acceptanceCriteria: "",
      expectedOutput: "",
      status: "completed",
      source: "delegation",
      idempotencyKey: "k",
      depth: 1,
      maxDepth: 3,
      maxChildren: 4,
      result: null,
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T11:00:00.000Z",
      startedAt: "2026-09-28T10:00:00.000Z",
      completedAt: "2026-09-28T11:00:00.000Z",
      ...overrides,
    });
  const root = task({ taskId: "root", parentTaskId: null, botId: "cto", threadId: null });
  const ids = new Set(["cto", "backend", "designer"]);

  it("counts handoffs per pair and separates the ones still open", () => {
    const counts = deriveDelegationCounts(
      [
        root,
        task({ taskId: "a" }),
        task({ taskId: "b" }),
        task({ taskId: "c", botId: "designer", status: "running", completedAt: null }),
        task({
          taskId: "old",
          completedAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
      ids,
      NOW,
    );
    expect(counts).toEqual([
      { from: "cto", to: "backend", recent: 2, running: 0 },
      { from: "cto", to: "designer", recent: 0, running: 1 },
    ]);
  });

  it("lists running handoffs oldest first, each pointing at the receiving bot's task chat", () => {
    const items = deriveWorkingNow(
      [
        root,
        task({
          taskId: "later",
          botId: "designer",
          status: "running",
          startedAt: "2026-09-29T11:00:00.000Z",
          threadId: "thread-d",
        }),
        task({
          taskId: "earlier",
          botId: "backend",
          status: "running",
          startedAt: "2026-09-29T10:50:00.000Z",
          threadId: "thread-b",
        }),
        task({ taskId: "done", status: "completed" }),
      ],
      ids,
    );
    expect(items.map((item) => item.taskId)).toEqual(["earlier", "later"]);
    expect(workingNowTarget(items[0]!)).toEqual({
      to: "/bots/$botId/$threadId",
      params: { botId: "backend", threadId: "thread-b" },
    });
    expect(workingNowTarget(items[1]!)).toEqual({
      to: "/bots/$botId/$threadId",
      params: { botId: "designer", threadId: "thread-d" },
    });
  });

  it("falls back to the task page until the task has a chat", () => {
    const [item] = deriveWorkingNow(
      [root, task({ taskId: "queued", status: "queued", threadId: null, startedAt: null })],
      ids,
    );
    expect(workingNowTarget(item!)).toEqual({ to: "/tasks/$taskId", params: { taskId: "queued" } });
  });

  it("reads how long a handoff has run", () => {
    const start = Date.parse("2026-09-29T10:00:00.000Z");
    expect(formatWorkingFor(start, start + 20_000)).toBe("Just now");
    expect(formatWorkingFor(start, start + 5 * 60_000)).toBe("5 min");
    expect(formatWorkingFor(start, start + 60 * 60_000)).toBe("1 h");
    expect(formatWorkingFor(start, start + 69 * 60_000)).toBe("1 h 9 min");
  });
});

describe("zoneIdAtPoint", () => {
  it("returns the first zone under the point, or null", () => {
    const zones = [
      { id: "lead:dev", rect: { x0: 0, y0: 0, x1: 60, y1: 60 } },
      { id: "team:dev", rect: { x0: 0, y0: 0, x1: 300, y1: 100 } },
    ];
    expect(zoneIdAtPoint(zones, 30, 30)).toBe("lead:dev");
    expect(zoneIdAtPoint(zones, 200, 50)).toBe("team:dev");
    expect(zoneIdAtPoint(zones, 200, 500)).toBeNull();
  });
});

describe("historyReachesCutoff", () => {
  const NOW = Date.parse("2026-09-29T12:00:00.000Z");
  const at = (iso: string) => ({
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(iso),
  });

  it("keeps paging while the oldest finished task is inside the week", () => {
    expect(
      historyReachesCutoff([at("2026-09-29T09:00:00.000Z"), at("2026-09-25T09:00:00.000Z")], NOW),
    ).toBe(false);
  });

  it("stops once a page reaches back past 7 days, or comes back empty", () => {
    expect(
      historyReachesCutoff([at("2026-09-28T09:00:00.000Z"), at("2026-09-20T09:00:00.000Z")], NOW),
    ).toBe(true);
    expect(historyReachesCutoff([], NOW)).toBe(true);
  });
});
