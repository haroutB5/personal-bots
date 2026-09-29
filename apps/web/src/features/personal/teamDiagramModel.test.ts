import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTeamGroups,
  countTeamMembers,
  deriveDelegationLinks,
  RECENT_DELEGATION_WINDOW_MS,
  teamDropHint,
  teamDropOutcome,
  type TeamDropBot,
} from "./teamDiagramModel";

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
    expect(
      teamDropOutcome(
        { botId: "planner", name: "Planner", team: "assistant" },
        { kind: "team", team: "Research" },
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
    // Remove team counts the same three the card draws.
    expect(countTeamMembers(roster, "Research")).toBe(3);
    expect(groups.map((group) => group.label)).toEqual(["Research"]);
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

  it("keeps the merged team a working drop target", () => {
    const roster: TeamDropBot[] = [
      { botId: "researcher", name: "Researcher", team: "RESEARCH", lead: true },
      { botId: "reader", name: "Reader", team: "research" },
      { botId: "planner", name: "Planner", team: "assistant" },
    ];
    const groups = buildTeamGroups(roster, ["Research"]);
    // One group for the team, under the registered spelling.
    expect(groups.map((group) => group.team)).toEqual(["assistant", "Research"]);
    expect(groups.map((group) => group.label)).toEqual(["Assistant's team", "Research"]);

    const target = { kind: "team" as const, team: groups.at(-1)!.team };
    // An outsider still lands on it.
    expect(teamDropOutcome(roster[2]!, target, roster)).toMatchObject({
      kind: "update",
      update: { team: "Research", lead: false },
    });
    // A member stored under another case is already there, so no write.
    expect(teamDropOutcome(roster[1]!, target, roster)).toEqual({
      kind: "none",
      message: "Reader is already on the Research.",
    });
    // And the lead of the merged team still cannot walk out on its members.
    expect(teamDropOutcome(roster[0]!, { kind: "team", team: "assistant" }, roster)).toMatchObject({
      kind: "blocked",
    });
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
  });

  it("says what letting go would do, and that nothing happens off-target", () => {
    expect(teamDropHint(roster[0]!, zone("team"), roster)).toBe(
      "Let go to move Planner to the Dev team.",
    );
    expect(teamDropHint(roster[0]!, zone("lead"), roster)).toBe(
      "Let go to make Planner the Dev team lead.",
    );
    expect(teamDropHint(roster[0]!, null, roster)).toBe(
      "Planner is over nothing. Let go to keep it where it is.",
    );
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
