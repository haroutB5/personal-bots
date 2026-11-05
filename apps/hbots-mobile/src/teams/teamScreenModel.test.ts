import type { PersonalBot, PersonalBotTeam, PersonalRemovedBot } from "@t3tools/contracts";
import { PersonalBotId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  leadConfirmFor,
  leaderChoices,
  liveBotIds,
  moveSheetOptions,
  newTeamButtonLabel,
  newTeamPlan,
  removeTeamLabel,
  removedBotRows,
  removedBotsState,
  teamCards,
  teamChartBots,
  teamScreenState,
  teamSummary,
} from "./teamScreenModel";

const botOf = (id: string, name: string, fields: Partial<PersonalBot> = {}): PersonalBot =>
  ({
    botId: PersonalBotId.make(id),
    name,
    avatarShape: "circle",
    avatarColor: "#123456",
    sortOrder: 0,
    ...fields,
  }) as unknown as PersonalBot;

const lead = botOf("bot-lead", "CTO", { team: "dev" as PersonalBotTeam, lead: true });
const member = botOf("bot-member", "Frontend", { team: "dev" as PersonalBotTeam, sortOrder: 1 });
const other = botOf("bot-other", "Research", { team: "research" as PersonalBotTeam, sortOrder: 2 });

const labelOf = (bot: PersonalBot): string | null =>
  bot.botId === "bot-lead" ? "Sonnet 5.5 · H" : null;

describe("teamChartBots", () => {
  it("keeps a group-only bot out unless it leads a team", () => {
    const groupOnly = botOf("bot-group", "Group only", { groupOnly: true });
    const groupLead = botOf("bot-group-lead", "Group lead", {
      groupOnly: true,
      team: "dev" as PersonalBotTeam,
      lead: true,
    });

    expect(teamChartBots([groupOnly, groupLead]).map((bot) => bot.name)).toEqual(["Group lead"]);
  });

  it("sorts by the bot's own order", () => {
    expect(teamChartBots([other, lead, member]).map((bot) => bot.name)).toEqual([
      "CTO",
      "Frontend",
      "Research",
    ]);
  });
});

describe("teamCards", () => {
  it("puts the lead first and keeps a custom empty team", () => {
    const cards = teamCards({
      bots: [member, lead, other],
      customTeams: ["research", "empty-lab"] as ReadonlyArray<PersonalBotTeam>,
      liveBotIds: new Set(["bot-member"]),
      modelLabelOf: labelOf,
    });

    expect(cards).toEqual([
      {
        team: "dev",
        label: "Dev team",
        total: 2,
        members: [
          {
            botId: "bot-lead",
            name: "CTO",
            avatarShape: "circle",
            avatarColor: "#123456",
            modelLabel: "Sonnet 5.5 · H",
            isLead: true,
            live: false,
          },
          {
            botId: "bot-member",
            name: "Frontend",
            avatarShape: "circle",
            avatarColor: "#123456",
            modelLabel: null,
            isLead: false,
            live: true,
          },
        ],
        custom: false,
        removable: false,
      },
      {
        team: "research",
        label: "research",
        total: 1,
        members: [
          {
            botId: "bot-other",
            name: "Research",
            avatarShape: "circle",
            avatarColor: "#123456",
            modelLabel: null,
            isLead: false,
            live: false,
          },
        ],
        custom: true,
        removable: false,
      },
      {
        team: "empty-lab",
        label: "empty-lab",
        total: 0,
        members: [],
        custom: true,
        removable: true,
      },
    ]);
  });
});

describe("team labels", () => {
  it("says teams, bots and how to move one", () => {
    expect(teamSummary(2, 5)).toBe("2 teams · 5 bots · tap a bot to move it");
    expect(teamSummary(1, 1)).toBe("1 team · 1 bot · tap a bot to move it");
  });

  it("only offers Remove when the team is empty", () => {
    expect(removeTeamLabel(true)).toBe("Remove team");
    expect(removeTeamLabel(false)).toBe("Remove team (move its bots first)");
  });
});

describe("teamScreenState", () => {
  const base = { listLoaded: true, listError: null, botCount: 2, teamCount: 1 };

  it("is offline before anything else", () => {
    expect(teamScreenState({ ...base, connected: false })).toEqual({ kind: "offline" });
  });

  it("shows the list error only while there is nothing cached", () => {
    expect(
      teamScreenState({
        ...base,
        connected: true,
        listLoaded: false,
        listError: "Can't reach your laptop.",
      }),
    ).toEqual({ kind: "error", message: "Can't reach your laptop." });
  });

  it("keeps the cached cards when a refresh fails", () => {
    expect(
      teamScreenState({ ...base, connected: true, listError: "Can't reach your laptop." }),
    ).toEqual({ kind: "ready" });
  });

  it("is loading until the list answers", () => {
    expect(teamScreenState({ ...base, connected: true, listLoaded: false })).toEqual({
      kind: "loading",
    });
  });

  it("is empty with no bots and no teams", () => {
    expect(teamScreenState({ ...base, connected: true, botCount: 0, teamCount: 0 })).toEqual({
      kind: "empty",
    });
  });

  it("is ready once there is something to draw", () => {
    expect(teamScreenState({ ...base, connected: true })).toEqual({ kind: "ready" });
  });
});

describe("liveBotIds", () => {
  it("maps a live thread back to its bot and ignores a settled one", () => {
    const shells = [
      { id: "thread-a", latestTurn: { state: "running" }, session: null },
      { id: "thread-b", latestTurn: { state: "completed" }, session: null },
    ];
    expect(
      liveBotIds(
        [
          { threadId: "thread-a", botId: "bot-a" },
          { threadId: "thread-b", botId: "bot-b" },
        ],
        shells as never,
      ),
    ).toEqual(new Set(["bot-a"]));
  });
});

describe("moveSheetOptions", () => {
  const roster = [lead, member, other];

  it("offers a disabled Stay for the bot's own team and a Move for another", () => {
    const options = moveSheetOptions(
      member,
      [
        { team: "dev", label: "Dev team", leadBotId: "bot-lead", memberBotIds: ["bot-member"] },
        { team: "research", label: "research", leadBotId: null, memberBotIds: ["bot-other"] },
      ],
      roster,
    );

    expect(options[0]).toMatchObject({
      title: "Stay on Dev team",
      detail: "Frontend is already on the Dev team.",
      disabled: true,
    });
    expect(options[2]).toMatchObject({
      title: "Move to research",
      detail: "Frontend moved to the research.",
      disabled: false,
    });
  });

  it("marks a lead seat that replaces someone for confirmation", () => {
    const options = moveSheetOptions(
      member,
      [{ team: "dev", label: "Dev team", leadBotId: "bot-lead", memberBotIds: ["bot-member"] }],
      roster,
    );
    const leadOption = options.find((option) => option.kind === "lead");

    expect(leadOption?.replaces).toEqual({
      oldLeadId: "bot-lead",
      oldLeadName: "CTO",
      openHandoffs: 0,
    });
  });
});

describe("leadConfirmFor", () => {
  it("names the new lead and says who stays on the team", () => {
    expect(leadConfirmFor(member, "dev" as PersonalBotTeam, [lead, member])).toEqual({
      title: "Make Frontend the Dev team lead?",
      lines: ["CTO stops leading and stays on the Dev team."],
      confirmLabel: "Make Frontend lead",
    });
  });

  it("is null when the seat is empty", () => {
    expect(leadConfirmFor(member, "research" as PersonalBotTeam, [lead, member])).toBeNull();
  });
});

describe("newTeamPlan", () => {
  it("refuses a name a registered team already uses", () => {
    expect(
      newTeamPlan({
        name: "dev team",
        leader: null,
        members: [],
        customTeams: [],
        allBots: [],
      }).nameError,
    ).toBe("There is already a team called Dev team.");
  });

  it("warns before a leader leaves its old team and plans the leader first", () => {
    const plan = newTeamPlan({
      name: "Research",
      leader: lead,
      members: [member],
      customTeams: [],
      allBots: [lead, member],
    });

    expect(plan.warning).toBe(
      "CTO leads Dev team; it will move to Research, and Dev team will have no lead.",
    );
    expect(plan.moves.map((move) => [move.name, move.lead])).toEqual([
      ["CTO", true],
      ["Frontend", false],
    ]);
  });

  it("announces a team with its leader and members", () => {
    expect(
      newTeamPlan({
        name: "Research",
        leader: null,
        members: [other],
        customTeams: [],
        allBots: [other],
      }).createdMessage,
    ).toBe("Team Research created. It has no lead yet. 1 bot moved in.");
  });
});

describe("newTeamButtonLabel", () => {
  it("names the leader, then says working and retry", () => {
    expect(newTeamButtonLabel({ busy: false, createdName: null, leaderName: null })).toBe(
      "Create team",
    );
    expect(newTeamButtonLabel({ busy: false, createdName: null, leaderName: "CTO" })).toBe(
      "Create team, CTO leads",
    );
    expect(newTeamButtonLabel({ busy: true, createdName: null, leaderName: null })).toBe(
      "Creating…",
    );
    expect(newTeamButtonLabel({ busy: false, createdName: "Research", leaderName: null })).toBe(
      "Try again",
    );
  });
});

describe("leaderChoices", () => {
  it("starts with no leader and says who leads what", () => {
    expect(leaderChoices([lead, member], labelOf)).toEqual([
      { botId: null, name: "No leader for now", detail: null, leads: null },
      {
        botId: "bot-lead",
        name: "CTO",
        detail: "Sonnet 5.5 · H",
        leads: "Leads Dev team",
      },
      { botId: "bot-member", name: "Frontend", detail: null, leads: null },
    ]);
  });
});

const removedBot = (id: string, name: string): PersonalRemovedBot =>
  ({
    botId: PersonalBotId.make(id),
    name,
    title: "",
    team: "dev",
    avatarShape: "circle",
    avatarColor: "#123456",
    modelLabel: "Sonnet 5.5",
    removedAt: DateTime.makeUnsafe("2026-11-01T10:00:00Z"),
    removedBy: "CFO",
    reason: null,
    chats: 4,
  }) as unknown as PersonalRemovedBot;

describe("removedBotsState", () => {
  it("distinguishes loading, error, empty and ready", () => {
    expect(removedBotsState({ loaded: false, error: null, rowCount: 0 })).toEqual({
      kind: "loading",
    });
    expect(removedBotsState({ loaded: false, error: "offline", rowCount: 0 })).toEqual({
      kind: "error",
      message: "offline",
    });
    expect(removedBotsState({ loaded: true, error: null, rowCount: 0 })).toEqual({ kind: "empty" });
    expect(removedBotsState({ loaded: true, error: null, rowCount: 1 })).toEqual({ kind: "ready" });
  });
});

describe("removedBotRows", () => {
  it("keeps a restored bot's row with the note", () => {
    const rows = removedBotRows({
      seen: [removedBot("bot-a", "Ada")],
      current: [],
      restored: { "bot-a": "Ada restored to Dev team" },
      nowMs: new Date("2026-11-05T10:00:00Z").getTime(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe("Ada restored to Dev team");
    expect(rows[0]?.subtitle).toBe("Dev team · Sonnet 5.5");
    expect(rows[0]?.removedBy).toBe("Removed by CFO on 1 Nov");
    expect(rows[0]?.chats).toBe("4 chats kept");
  });

  it("drops a bot that left the list with no restore note", () => {
    expect(
      removedBotRows({ seen: [removedBot("bot-a", "Ada")], current: [], restored: {}, nowMs: 0 }),
    ).toEqual([]);
  });
});
