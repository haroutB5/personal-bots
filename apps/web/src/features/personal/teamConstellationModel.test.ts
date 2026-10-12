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
  leadConfirmCopy,
  leadLabelSizes,
  MAX_ORBIT_NODES,
  memberLabelSizes,
  NODE_AVATAR,
  NODE_NAME_WIDTH,
  NODE_WIDTH,
  planDrop,
  replacedLead,
  teamLayoutOverlaps,
  teamMoveTargets,
  undoMessage,
  undoPlan,
  workingNowTarget,
  zoneIdAtPoint,
} from "./teamConstellationModel";

/** The design's own Build team (mockups/final.html), long name included. */
const BUILD_TEAM: ReadonlyArray<{ name: string; caption: string }> = [
  { name: "Pixel", caption: "Opus 5.5 · H" },
  { name: "Forge", caption: "Working" },
  { name: "Probe", caption: "Thinking" },
  { name: "Relay", caption: "Needs approval" },
  { name: "Release Notes Copywriter", caption: "Haiku 5.5 · M" },
  { name: "Sentinel", caption: "Sonnet 5.5 · H" },
  { name: "Harbor", caption: "Sonnet 5.5 · M" },
  { name: "Quill", caption: "Sonnet 5.5 · M" },
];
const BUILD_LEAD = { name: "Atlas", caption: "Planning release 2.4" };
const AVATAR_ONLY = { nameWidth: 0, captionWidth: 0 };
describe("buildConstellationLayout", () => {
  it("never lets two avatars touch, at every team size and phone width", () => {
    for (const width of [320, 350, 358, 390, 430]) {
      for (let count = 0; count <= 24; count += 1) {
        const layout = buildConstellationLayout(count, width);
        expect(
          teamLayoutOverlaps(layout, { member: AVATAR_ONLY, lead: AVATAR_ONLY }),
          `${String(count)} members at ${String(width)}`,
        ).toBe(0);
      }
    }
  });

  it("keeps a 9-bot Build team clean, wide name included", () => {
    // Eight members plus the lead: rx 124, ry 140, the first member at 12 o'clock.
    const layout = buildConstellationLayout(8, 358);
    expect(layout.rx).toBe(124);
    expect(layout.ry).toBe(140);
    expect(layout.slots).toHaveLength(8);
    expect(layout.hidden).toBe(0);
    // The first member sits at 12 o'clock, straight above the lead.
    expect(layout.slots[0]!.x).toBe(layout.hub.x);
    expect(layout.slots[0]!.y).toBeLessThan(layout.hub.y);
    expect(
      teamLayoutOverlaps(layout, {
        member: BUILD_TEAM.map((entry) => memberLabelSizes(entry.name, entry.caption)),
        lead: leadLabelSizes(BUILD_LEAD.name, BUILD_LEAD.caption),
      }),
    ).toBe(0);
  });

  it("starts two to five members half a step past 12 o'clock, so nobody sits on the lead's name", () => {
    const layout = buildConstellationLayout(4, 358);
    expect(layout.rx).toBe(112);
    expect(layout.ry).toBe(72);
    expect(layout.slots[0]!.x).not.toBe(layout.hub.x);
    expect(
      teamLayoutOverlaps(layout, {
        member: memberLabelSizes("Scout", "Needs your reply"),
        lead: leadLabelSizes("Juno", "Needs your reply"),
      }),
    ).toBe(0);
  });

  it("opens the ring by 16 px a member past the eighth", () => {
    expect(buildConstellationLayout(8, 358).ry).toBe(140);
    expect(buildConstellationLayout(9, 358).ry).toBe(156);
    expect(buildConstellationLayout(12, 358).ry).toBe(204);
  });

  it("puts a lead that is alone at the top, above its own name", () => {
    const layout = buildConstellationLayout(0, 358);
    expect(layout.slots).toEqual([]);
    expect(layout.hub).toEqual({ x: 179, y: 72 });
    expect(layout.height).toBeGreaterThan(0);
  });

  it("gives a single member the tall ring at 12 o'clock, clear of the lead's name", () => {
    const layout = buildConstellationLayout(1, 358);
    expect(layout.ry).toBe(140);
    expect(layout.slots[0]!.x).toBe(layout.hub.x);
    expect(
      teamLayoutOverlaps(layout, {
        member: memberLabelSizes("Release Notes Copywriter", "Sonnet 5.5 · M"),
        lead: leadLabelSizes("Atlas", "Planning release 2.4"),
      }),
    ).toBe(0);
  });

  it("pulls the ring in rather than let a node run off a narrow card", () => {
    const narrow = buildConstellationLayout(6, 240);
    expect(narrow.rx).toBeLessThan(124);
    for (const slot of narrow.slots) {
      expect(slot.x - NODE_WIDTH / 2).toBeGreaterThanOrEqual(0);
      expect(slot.x + NODE_WIDTH / 2).toBeLessThanOrEqual(narrow.width);
    }
  });

  it("puts the rest behind a +N seat past the most a card draws", () => {
    const layout = buildConstellationLayout(26, 358);
    expect(layout.slots).toHaveLength(MAX_ORBIT_NODES);
    // One seat fewer than the cap is drawn; the last seat says how many are left.
    expect(layout.hidden).toBe(26 - (MAX_ORBIT_NODES - 1));
    expect(buildConstellationLayout(MAX_ORBIT_NODES, 358).hidden).toBe(0);
  });

  it("leaves room under the lowest caption for the card's own padding", () => {
    const layout = buildConstellationLayout(8, 358);
    const lowestCaption = Math.max(
      ...layout.slots.map((slot) => slot.y + NODE_AVATAR / 2 + 4 + 32 + 16),
    );
    expect(layout.height).toBeGreaterThan(lowestCaption);
  });
});

describe("label sizes", () => {
  it("caps a member's name at two lines and its caption at the column", () => {
    expect(memberLabelSizes("QA", "Working").nameWidth).toBeLessThan(NODE_NAME_WIDTH);
    expect(memberLabelSizes("Release Notes Copywriter", "Haiku 5.5 · M").nameWidth).toBe(
      NODE_NAME_WIDTH,
    );
    expect(
      memberLabelSizes("QA", "A very long caption that runs past the column").captionWidth,
    ).toBe(NODE_WIDTH);
  });

  it("caps the lead's plates at its own column", () => {
    expect(leadLabelSizes("Atlas", "Planning release 2.4").nameWidth).toBeLessThan(80);
    expect(
      leadLabelSizes("A lead with an extremely long name here", "x").nameWidth,
    ).toBeLessThanOrEqual(160);
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
