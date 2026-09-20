import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTeamConnectors,
  buildTeamDropZones,
  buildTeamGroups,
  buildTeamGroupsLayout,
  countTeamMembers,
  crossTeamDelegationPath,
  delegationConnectorPath,
  deriveDelegationLinks,
  hitTestTeamDropZone,
  laneDelegationPath,
  orthogonalPath,
  RECENT_DELEGATION_WINDOW_MS,
  teamConnectorLanes,
  teamDiagramSummary,
  teamDropHint,
  teamDropOutcome,
  type TeamDiagramPoint,
  type TeamDropBot,
  type TeamGroupsLayout,
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
  it("keeps custom teams visible and usable as drop targets before and after assigning bots", () => {
    const groups = buildTeamGroups(ROSTER, ["Research"]);
    expect(groups.at(-1)).toEqual({
      team: "Research",
      label: "Research",
      leadBotId: null,
      memberBotIds: [],
    });
    const layout = buildTeamGroupsLayout(groups, LAYOUT);
    const zone = buildTeamDropZones(layout, LAYOUT).find((zone) => zone.id === "band:Research")!;
    expect(zone.rect.height).toBeGreaterThanOrEqual(44);
    expect(
      teamDropOutcome(
        { botId: "planner", name: "Planner", team: "assistant" },
        zone.target,
        ROSTER.map((bot) => ({ ...bot, name: bot.botId })),
      ),
    ).toMatchObject({ kind: "update", update: { team: "Research", lead: false } });
    expect(
      buildTeamGroups([{ botId: "researcher", team: "Research", lead: true }], ["Research"]).at(-1),
    ).toMatchObject({ label: "Research", leadBotId: "researcher" });
  });
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

  // Rows written before requireKnownTeam (v1.21.4) started writing the
  // registered spelling back can still differ from the profile only in case.
  // Two bands with the same name is the bug; nothing here rewrites a row.
  it("draws one band for case-variant stored teams, under the registered spelling", () => {
    const roster = [
      { botId: "researcher", team: "RESEARCH", lead: true },
      { botId: "reader", team: "research" },
      { botId: "writer", team: "Research" },
    ];
    const groups = buildTeamGroups(roster, ["Research"]);
    expect(groups.filter((group) => group.label.toLowerCase() === "research")).toEqual([
      {
        team: "Research",
        label: "Research",
        leadBotId: "researcher",
        memberBotIds: ["reader", "writer"],
      },
    ]);
    // Manage teams counts the same three the band draws.
    expect(countTeamMembers(roster, "Research")).toBe(3);
    expect(buildTeamGroupsLayout(groups, LAYOUT).bands.map((band) => band.label)).toEqual([
      "Research",
    ]);
  });

  it("folds a case-variant built-in team under its built-in label", () => {
    expect(buildTeamGroups([{ botId: "cto", team: "DEV", lead: true }])).toEqual([
      { team: "dev", label: "Dev team", leadBotId: "cto", memberBotIds: [] },
    ]);
  });

  // Nobody registered this one, so the first stored spelling is all there is.
  it("falls back to the first stored spelling for an unregistered team", () => {
    expect(
      buildTeamGroups([
        { botId: "a", team: "Skunkworks" },
        { botId: "b", team: "SKUNKWORKS" },
      ]),
    ).toEqual([
      { team: "Skunkworks", label: "Skunkworks", leadBotId: null, memberBotIds: ["a", "b"] },
    ]);
  });

  it("keeps the merged band a working drop target", () => {
    const roster: TeamDropBot[] = [
      { botId: "researcher", name: "Researcher", team: "RESEARCH", lead: true },
      { botId: "reader", name: "Reader", team: "research" },
      { botId: "planner", name: "Planner", team: "assistant" },
    ];
    const groups = buildTeamGroups(roster, ["Research"]);
    const layout = buildTeamGroupsLayout(groups, LAYOUT);
    const zones = buildTeamDropZones(layout, LAYOUT);
    // One band zone for the team, under the registered spelling.
    const bandZones = zones.filter((zone) => zone.id.startsWith("band:"));
    expect(bandZones.map((zone) => zone.id)).toEqual(["band:assistant", "band:Research"]);
    expect(bandZones.map((zone) => zone.label)).toEqual(["Assistant's team", "Research"]);

    const band = bandZones.at(-1)!;
    expect(band.target).toEqual({ kind: "team", team: "Research" });
    // An outsider still lands on it.
    expect(teamDropOutcome(roster[2]!, band.target, roster)).toMatchObject({
      kind: "update",
      update: { team: "Research", lead: false },
    });
    // A member stored under another case is already there, so no write.
    expect(teamDropOutcome(roster[1]!, band.target, roster)).toEqual({
      kind: "none",
      message: "Reader is already on the Research.",
    });
    // And the lead of the merged band still cannot walk out on its members.
    expect(teamDropOutcome(roster[0]!, { kind: "team", team: "assistant" }, roster)).toMatchObject({
      kind: "blocked",
    });
    // Hit-testing inside the band finds that one zone.
    expect(hitTestTeamDropZone(zones, { x: 10, y: band.rect.y + band.rect.height / 2 })?.id).toBe(
      "band:Research",
    );
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

/** The band that made the owner's screenshot read as one chain: five dev bots. */
const CROWDED = [
  { botId: "cto", team: "dev" as const, lead: true },
  { botId: "frontend", team: "dev" as const },
  { botId: "backend", team: "dev" as const },
  { botId: "devops", team: "dev" as const },
  { botId: "security", team: "dev" as const },
  { botId: "assistant", team: "assistant" as const, lead: true },
  { botId: "planner", team: "assistant" as const },
];
const CONNECTOR_OPTIONS = {
  width: LAYOUT.width,
  leadSize: LAYOUT.leadSize,
  nodeSize: LAYOUT.nodeSize,
  labelWidth: 96,
};
/** `LABEL_SPACE` in the model: the name and title printed under a node. */
const LABEL_SPACE = 48;

function pointsOf(path: string): TeamDiagramPoint[] {
  const numbers = path.match(/-?[\d.]+/g)?.map(Number) ?? [];
  const points: TeamDiagramPoint[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index]!, y: numbers[index + 1]! });
  }
  return points;
}

/**
 * Every point the connector passes through, corners included, at 2-unit steps.
 * A single-curve path (the bowed delegation edge) is sampled along the curve
 * itself: its control point sits far above the ink, so walking the control
 * polygon would miss everything the bow actually passes over.
 */
function samplesOf(path: string): TeamDiagramPoint[] {
  const points = pointsOf(path);
  if (points.length === 3 && path.split("Q").length === 2) {
    const [start, control, end] = points as [TeamDiagramPoint, TeamDiagramPoint, TeamDiagramPoint];
    const steps = 200;
    return Array.from({ length: steps + 1 }, (_unused, step) => {
      const t = step / steps;
      const inverse = 1 - t;
      return {
        x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
        y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
      };
    });
  }
  const corners = points;
  const samples: TeamDiagramPoint[] = [];
  for (let index = 0; index + 1 < corners.length; index += 1) {
    const from = corners[index]!;
    const to = corners[index + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    for (let step = 0; step <= steps; step += 1) {
      samples.push({
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      });
    }
  }
  return samples;
}

/** Bots a line passes over — their avatar or the name column printed under it. */
function botsCrossedBy(
  path: string,
  layout: TeamGroupsLayout,
  sizeOf: (botId: string) => number,
): string[] {
  const samples = samplesOf(path);
  expect(samples.length).toBeGreaterThan(1);
  return [...layout.bots]
    .filter(([botId, node]) => {
      const size = sizeOf(botId);
      return samples.some(
        (sample) =>
          (Math.abs(sample.x - node.x) <= CONNECTOR_OPTIONS.labelWidth / 2 &&
            sample.y >= node.y + size / 2 &&
            sample.y <= node.y + size / 2 + LABEL_SPACE) ||
          Math.hypot(sample.x - node.x, sample.y - node.y) < size / 2 + 2,
      );
    })
    .map(([botId]) => botId);
}

describe("orthogonalPath", () => {
  it("rounds each corner and collapses repeated points", () => {
    expect(
      orthogonalPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 100 },
          { x: 80, y: 100 },
        ],
        10,
      ),
    ).toBe("M 0 0 L 0 90 Q 0 100 10 100 L 80 100");
    expect(orthogonalPath([{ x: 5, y: 5 }], 10)).toBe("");
  });
});

describe("buildTeamConnectors", () => {
  const groups = buildTeamGroups(CROWDED);
  const layout = buildTeamGroupsLayout(groups, LAYOUT);
  const connectors = buildTeamConnectors(groups, layout, CONNECTOR_OPTIONS);
  const sizeOf = (botId: string) =>
    botId === "cto" || botId === "assistant" ? LAYOUT.leadSize : LAYOUT.nodeSize;

  const crossedBy = (path: string) => botsCrossedBy(path, layout, sizeOf);

  it("never draws a line across a bot it does not connect to", () => {
    // The screenshot bug: the owner's straight line to the assistant's lead ran
    // down the centre through the whole dev band, so Security looked like it
    // reported into the other team, and the two teams read as one chain.
    const straightOwnerLine = orthogonalPath([layout.owner, layout.bots.get("assistant")!], 0);
    // Negative control: the line this replaced really is caught by the check.
    expect(crossedBy(straightOwnerLine)).toContain("cto");

    for (const connector of connectors) {
      expect(`${connector.key}: ${crossedBy(connector.d).join(",")}`).toBe(`${connector.key}: `);
    }
  });

  it("keeps both lanes to the left of every name column", () => {
    const lanes = teamConnectorLanes(layout, CONNECTOR_OPTIONS);
    const leftmostColumn = [...layout.bots.values()].reduce(
      (min, node) => Math.min(min, node.x - CONNECTOR_OPTIONS.labelWidth / 2),
      LAYOUT.width,
    );
    expect(lanes.owner).toBeGreaterThan(0);
    expect(lanes.owner).toBeLessThan(lanes.member);
    expect(lanes.member).toBeLessThan(leftmostColumn);
    expect(lanes.cross).toBeGreaterThan(LAYOUT.width / 2);
  });

  it("gives each team one owner line and its own member trunk", () => {
    expect(connectors.filter((line) => line.kind === "owner").map((line) => line.key)).toEqual([
      "owner:dev",
      "owner:assistant",
    ]);
    expect(
      connectors.filter((line) => line.key.startsWith("trunk:")).map((line) => line.key),
    ).toEqual(["trunk:dev", "trunk:assistant"]);
    // One arrow per member, arriving from above, plus the two owner lines.
    const arrows = connectors.filter((line) => line.arrow);
    expect(arrows).toHaveLength(2 + 5);
    for (const drop of arrows.filter((line) => line.key.startsWith("drop:"))) {
      const [start, end] = pointsOf(drop.d);
      expect(start!.x).toBe(end!.x);
      expect(start!.y).toBeLessThan(end!.y);
    }
  });

  it("does not reach into a band it does not own", () => {
    const devBand = layout.bands.find((band) => band.team === "dev")!;
    for (const connector of connectors.filter((line) => line.key.endsWith(":assistant"))) {
      for (const sample of samplesOf(connector.d)) {
        // Crossing the dev band is unavoidable for a line that starts above it,
        // but only ever out in the owner lane, never among the dev bots.
        if (sample.y > devBand.top && sample.y < devBand.bottom) {
          expect(sample.x).toBeLessThan(40);
        }
      }
    }
  });
});

describe("crossTeamDelegationPath", () => {
  const groups = buildTeamGroups(CROWDED);
  const layout = buildTeamGroupsLayout(groups, LAYOUT);
  const lanes = teamConnectorLanes(layout, CONNECTOR_OPTIONS);

  it("routes a cross-team handoff down the right lane, not through the diagram", () => {
    const from = layout.bots.get("frontend")!;
    const to = layout.bots.get("planner")!;
    const path = crossTeamDelegationPath(from, to, {
      lane: lanes.cross,
      nodeSize: LAYOUT.nodeSize,
    });
    const samples = samplesOf(path);

    // Both ends leave and arrive from straight above their own node, so the
    // line never runs sideways through the bots sharing Frontend's row.
    expect(samples.at(0)).toEqual({ x: from.x, y: from.y - 38 });
    expect(samples.at(-1)).toEqual({ x: to.x, y: to.y - 40 });
    for (const botId of ["backend", "devops", "security", "assistant", "cto"]) {
      const node = layout.bots.get(botId)!;
      const size = botId === "cto" || botId === "assistant" ? LAYOUT.leadSize : LAYOUT.nodeSize;
      for (const sample of samples) {
        expect(Math.hypot(sample.x - node.x, sample.y - node.y)).toBeGreaterThan(size / 2);
      }
    }
    // Everything between the two rows sits out in the right-hand lane.
    for (const sample of samples) {
      if (sample.y > from.y + 40 && sample.y < to.y - 80) {
        expect(sample.x).toBeGreaterThan(LAYOUT.width - 20);
      }
    }
  });
});

describe("laneDelegationPath", () => {
  const groups = buildTeamGroups(CROWDED);
  const layout = buildTeamGroupsLayout(groups, LAYOUT);
  const lanes = teamConnectorLanes(layout, CONNECTOR_OPTIONS);
  const sizeOf = (botId: string) =>
    botId === "cto" || botId === "assistant" ? LAYOUT.leadSize : LAYOUT.nodeSize;
  const pathBetween = (fromId: string, toId: string) =>
    laneDelegationPath(layout.bots.get(fromId)!, layout.bots.get(toId)!, {
      lane: lanes.delegation,
      fromSize: sizeOf(fromId),
      toSize: sizeOf(toId),
    });
  /** Everyone but the two the line connects: those two it may touch. */
  const othersCrossedBy = (path: string, fromId: string, toId: string) =>
    botsCrossedBy(path, layout, sizeOf).filter((botId) => botId !== fromId && botId !== toId);

  it("keeps a lead's delegation off the member rows it passes", () => {
    // The screenshot bug: the CTO's grey dashed line to a bot further down the
    // band bowed only 35 units aside, which is inside the opaque name column of
    // whoever sits between them, so it read as noise across the member row.
    const bowed = delegationConnectorPath(
      layout.bots.get("cto")!,
      layout.bots.get("security")!,
      LAYOUT.nodeSize,
    );
    // Negative control: the curve this replaced really is caught by the check.
    expect(othersCrossedBy(bowed, "cto", "security")).toContain("backend");

    for (const [fromId, toId] of [
      ["cto", "devops"],
      ["cto", "security"],
      ["cto", "frontend"],
      ["security", "cto"],
      ["frontend", "security"],
    ] as const) {
      const key = `${fromId}->${toId}`;
      expect(`${key}: ${othersCrossedBy(pathBetween(fromId, toId), fromId, toId).join(",")}`).toBe(
        `${key}: `,
      );
    }
  });

  it("runs its lane inside the cross-team lane and clear of every name column", () => {
    const rightmostColumn = [...layout.bots.values()].reduce(
      (max, node) => Math.max(max, node.x + CONNECTOR_OPTIONS.labelWidth / 2),
      0,
    );
    expect(lanes.delegation).toBeGreaterThan(rightmostColumn);
    expect(lanes.delegation).toBeLessThan(lanes.cross);

    // Leaves and arrives from straight above each node, never sideways through
    // the team-mates sharing a row.
    const from = layout.bots.get("cto")!;
    const to = layout.bots.get("devops")!;
    const samples = samplesOf(pathBetween("cto", "devops"));
    expect(samples.at(0)).toEqual({ x: from.x, y: from.y - LAYOUT.leadSize / 2 - 6 });
    expect(samples.at(-1)).toEqual({ x: to.x, y: to.y - LAYOUT.nodeSize / 2 - 8 });
    // Everything between the two rows sits out in that lane.
    for (const sample of samples) {
      if (sample.y > from.y + 40 && sample.y < to.y - 80) {
        expect(sample.x).toBeGreaterThan(lanes.delegation - 12);
      }
    }
  });
});

describe("buildTeamDropZones", () => {
  const layout = buildTeamGroupsLayout(buildTeamGroups(CROWDED), LAYOUT);
  const zones = buildTeamDropZones(layout, {
    width: LAYOUT.width,
    leadSize: LAYOUT.leadSize,
    nodeSize: LAYOUT.nodeSize,
  });

  it("offers a lead slot and a chief node per team, then the whole band", () => {
    expect(zones.map((zone) => zone.id)).toEqual([
      "lead:dev",
      "lead:assistant",
      "chief:dev",
      "chief:assistant",
      "band:dev",
      "band:assistant",
    ]);
  });

  it("prefers the lead slot, then the chief, then the band under the finger", () => {
    const at = (botId: string) => layout.bots.get(botId)!;
    const cto = at("cto");
    expect(hitTestTeamDropZone(zones, { x: cto.x + 60, y: cto.y })?.id).toBe("lead:dev");
    expect(hitTestTeamDropZone(zones, cto)?.id).toBe("chief:dev");
    expect(hitTestTeamDropZone(zones, at("security"))?.id).toBe("band:dev");
    expect(hitTestTeamDropZone(zones, at("planner"))?.id).toBe("band:assistant");
    // Above the first band — the owner's own row — is not a drop target.
    expect(hitTestTeamDropZone(zones, layout.owner)).toBeNull();
    expect(hitTestTeamDropZone(zones, { x: cto.x, y: layout.svgHeight + 200 })).toBeNull();
  });

  it("never lets the lead slot run off the right edge", () => {
    for (const zone of zones) {
      expect(zone.rect.x).toBeGreaterThanOrEqual(0);
      expect(zone.rect.x + zone.rect.width).toBeLessThanOrEqual(LAYOUT.width);
    }
  });
});

describe("teamDropOutcome", () => {
  const roster: ReadonlyArray<TeamDropBot> = [
    { botId: "cto", name: "CTO", team: "dev", lead: true },
    { botId: "security", name: "Security", team: "dev" },
    { botId: "assistant", name: "Assistant", team: "assistant", lead: true },
    { botId: "planner", name: "Planner", team: "assistant" },
  ];
  const bot = (botId: string) => roster.find((entry) => entry.botId === botId)!;

  it("moves a member to the other team as a member", () => {
    expect(teamDropOutcome(bot("security"), { kind: "team", team: "assistant" }, roster)).toEqual({
      kind: "update",
      message: "Security moved to the Assistant's team.",
      update: { team: "assistant", lead: false },
    });
  });

  it("promotes onto the lead slot, which the server swaps in one write", () => {
    expect(teamDropOutcome(bot("planner"), { kind: "lead", team: "dev" }, roster)).toEqual({
      kind: "update",
      message: "Planner now leads the Dev team.",
      update: { team: "dev", lead: true },
    });
    // Same team, lead slot: still a promotion, and it demotes the current lead.
    expect(teamDropOutcome(bot("planner"), { kind: "lead", team: "assistant" }, roster)).toEqual({
      kind: "update",
      message: "Planner now leads the Assistant's team.",
      update: { team: "assistant", lead: true },
    });
  });

  it("does nothing when the drop changes nothing", () => {
    expect(teamDropOutcome(bot("security"), { kind: "team", team: "dev" }, roster).kind).toBe(
      "none",
    );
    expect(teamDropOutcome(bot("cto"), { kind: "lead", team: "dev" }, roster)).toEqual({
      kind: "none",
      message: "CTO already leads the Dev team.",
    });
  });

  it("refuses to leave a team with members but no lead", () => {
    const outcome = teamDropOutcome(bot("cto"), { kind: "team", team: "assistant" }, roster);
    expect(outcome.kind).toBe("blocked");
    expect(outcome.message).toContain("Make someone else the lead");
    // Even onto the other team's lead slot: the dev team still loses its head.
    expect(teamDropOutcome(bot("cto"), { kind: "lead", team: "assistant" }, roster).kind).toBe(
      "blocked",
    );
  });

  it("lets the last bot on a team leave, lead or not", () => {
    const soloRoster: ReadonlyArray<TeamDropBot> = [
      { botId: "cto", name: "CTO", team: "dev", lead: true },
      { botId: "assistant", name: "Assistant", team: "assistant", lead: true },
    ];
    expect(
      teamDropOutcome(soloRoster[0]!, { kind: "team", team: "assistant" }, soloRoster),
    ).toEqual({
      kind: "update",
      message: "CTO moved to the Assistant's team.",
      update: { team: "assistant", lead: false },
    });
  });

  it("treats a bot from a server without teams as a member of the assistant's", () => {
    const legacy: TeamDropBot = { botId: "scout", name: "Scout" };
    expect(teamDropOutcome(legacy, { kind: "team", team: "assistant" }, [legacy]).kind).toBe(
      "none",
    );
    expect(teamDropOutcome(legacy, { kind: "team", team: "dev" }, [legacy]).kind).toBe("update");
  });
});

describe("teamDropHint", () => {
  const roster: ReadonlyArray<TeamDropBot> = [
    { botId: "planner", name: "Planner", team: "assistant" },
  ];
  const zone = (kind: "team" | "lead") => ({
    id: "z",
    target: { kind, team: "dev" as const },
    label: "Dev team",
    rect: { x: 0, y: 0, width: 1, height: 1 },
  });

  it("says what letting go would do, and that nothing happens off-target", () => {
    expect(teamDropHint(roster[0]!, zone("team"), roster)).toBe(
      "Let go to make it so: Planner moved to the Dev team.",
    );
    expect(teamDropHint(roster[0]!, zone("lead"), roster)).toBe(
      "Let go to make it so: Planner now leads the Dev team.",
    );
    expect(teamDropHint(roster[0]!, null, roster)).toBe(
      "Planner is over nothing. Let go to leave the team as it is.",
    );
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

  it("clears whoever stands between the two ends of one row", () => {
    // Same row is the one shape the bow keeps: it arcs over the top of the row
    // rather than down through it, so the same "crosses a bot?" check that
    // guards the lanes holds for the bot standing in between.
    const layout = buildTeamGroupsLayout(buildTeamGroups(CROWDED), LAYOUT);
    const sizeOf = (botId: string) =>
      botId === "cto" || botId === "assistant" ? LAYOUT.leadSize : LAYOUT.nodeSize;
    for (const [fromId, toId] of [
      ["frontend", "backend"],
      ["frontend", "devops"],
      ["devops", "frontend"],
    ] as const) {
      const path = delegationConnectorPath(
        layout.bots.get(fromId)!,
        layout.bots.get(toId)!,
        LAYOUT.nodeSize,
      );
      const key = `${fromId}->${toId}`;
      expect(`${key}: ${botsCrossedBy(path, layout, sizeOf).join(",")}`).toBe(`${key}: `);
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

describe("countTeamMembers", () => {
  it("counts a bot whose stored team differs only in case, so Remove matches the server", () => {
    const bots = [
      { botId: "a", team: "RESEARCH" },
      { botId: "b", team: "Research" },
      { botId: "c", team: "assistant" },
      // No team stored at all is the assistant's team, same as botTeam().
      { botId: "d" },
    ];

    // The server refuses to remove "Research" while either of a/b is on it, so
    // the screen must not offer Remove by reporting 0 bots.
    expect(countTeamMembers(bots, "Research")).toBe(2);
    expect(countTeamMembers(bots, "research")).toBe(2);
    expect(countTeamMembers(bots, "assistant")).toBe(2);
    expect(countTeamMembers(bots, "Finance")).toBe(0);
  });
});
