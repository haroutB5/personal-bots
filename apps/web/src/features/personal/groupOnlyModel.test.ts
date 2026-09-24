import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { PersonalBot, PersonalBotThread, PersonalGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  addableBots,
  memberRemovalMessage,
  reusablePrivateChat,
  shownInChats,
  shownInTeamChart,
} from "./groupOnlyModel";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);
const decodeLink = Schema.decodeUnknownSync(PersonalBotThread);

const at = "2026-09-24T21:00:00.000Z";

function bot(botId: string, extra: Record<string, unknown> = {}): PersonalBot {
  return decodeBot({
    botId,
    name: botId,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "pill",
    avatarColor: "#E8711A",
    modelSelection: { instanceId: "someRuntime", model: "some-model" },
    enabled: true,
    sortOrder: 0,
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
}

function group(groupId: string, name: string, members: ReadonlyArray<[string, string]>) {
  return decodeGroup({
    groupId,
    name,
    description: "",
    threadId: `${groupId}-thread`,
    maxBotTurns: 8,
    members: members.map(([botId, threadId], index) => ({
      groupId,
      botId,
      threadId,
      role: "member",
      sortOrder: index,
      deliveredSeq: 0,
      joinedAt: at,
      leftAt: null,
    })),
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  });
}

function link(botId: string, threadId: string, extra: Record<string, unknown> = {}) {
  return decodeLink({ botId, threadId, createdAt: at, archivedAt: null, ...extra });
}

function shell(id: string, extra: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id,
    createdAt: at,
    archivedAt: null,
    latestTurn: null,
    latestUserMessageAt: null,
    ...extra,
  } as unknown as EnvironmentThreadShell;
}

describe("shownInChats", () => {
  it("leaves out group-only bots and keeps the rest in order", () => {
    const rows = [
      { bot: bot("ada") },
      { bot: bot("luna1", { groupOnly: true, groupIds: ["lunas"] }) },
      { bot: bot("sol", { groupOnly: false, groupIds: ["lunas"] }) },
    ];
    expect(shownInChats(rows).map((row) => row.bot.botId)).toEqual(["ada", "sol"]);
  });

  it("shows a bot again the moment the server stops calling it group-only", () => {
    const hidden = [{ bot: bot("luna1", { groupOnly: true, groupIds: ["lunas"] }) }];
    expect(shownInChats(hidden)).toEqual([]);
    const back = [{ bot: bot("luna1", { groupOnly: false, groupIds: ["lunas"] }) }];
    expect(shownInChats(back).map((row) => row.bot.botId)).toEqual(["luna1"]);
  });

  it("shows every bot from an older server that sends no flag", () => {
    expect(shownInChats([{ bot: bot("ada") }])).toHaveLength(1);
  });
});

describe("shownInTeamChart", () => {
  it("drops group-only bots but never a team lead", () => {
    const bots = [
      bot("cto", { team: "dev", lead: true, groupOnly: true, groupIds: ["g"] }),
      bot("luna1", { team: "dev", groupOnly: true, groupIds: ["g"] }),
      bot("dev", { team: "dev" }),
    ];
    expect(shownInTeamChart(bots).map((entry) => entry.botId)).toEqual(["cto", "dev"]);
  });
});

describe("memberRemovalMessage", () => {
  const lunas = group("lunas", "Lunas", [["luna1", "relay-1"]]);
  const side = group("side", "Side project", [["luna1", "relay-2"]]);

  it("says a group-only bot moves back to the Bots list", () => {
    expect(
      memberRemovalMessage({
        bot: bot("luna1", { name: "Luna1", groupOnly: true, groupIds: ["lunas"] }),
        botName: "Luna1",
        group: lunas,
        groups: [lunas],
      }),
    ).toBe(
      "Remove Luna1 from Lunas?\nIt isn't in any other group, so it moves back to your Bots list. Nothing is deleted.",
    );
  });

  it("names the other group a bot stays in", () => {
    expect(
      memberRemovalMessage({
        bot: bot("luna1", { name: "Luna1", groupOnly: true, groupIds: ["lunas", "side"] }),
        botName: "Luna1",
        group: lunas,
        groups: [lunas, side],
      }),
    ).toBe("Remove Luna1 from Lunas?\nIt stays in Side project.");
  });

  it("says a bot with its own chats stays in the list", () => {
    expect(
      memberRemovalMessage({
        bot: bot("ada", { name: "Ada", groupOnly: false, groupIds: ["lunas"] }),
        botName: "Ada",
        group: lunas,
        groups: [lunas],
      }),
    ).toBe("Remove Ada from Lunas?\nIt stays in your Bots list with its own chats.");
  });
});

describe("reusablePrivateChat", () => {
  const relays = new Set(["relay-1"]);

  it("reuses the newest empty private chat and never a group relay", () => {
    const links = [
      link("luna1", "relay-1"),
      link("luna1", "empty-old"),
      link("luna1", "empty-new"),
      link("luna1", "written", { newestMessage: { id: "m1", role: "user", text: "hi" } }),
      link("luna1", "archived", { archivedAt: at }),
      link("other", "someone-else"),
    ];
    const shells = [
      // The relay looks empty from here and is still never picked.
      shell("relay-1", { createdAt: "2026-09-24T23:00:00.000Z" }),
      shell("empty-old", { createdAt: "2026-09-21T19:00:00.000Z" }),
      shell("empty-new", { createdAt: "2026-09-22T18:00:00.000Z" }),
      shell("written", { createdAt: "2026-09-23T10:00:00.000Z" }),
      shell("archived", { createdAt: "2026-09-24T10:00:00.000Z" }),
      shell("someone-else", { createdAt: "2026-09-24T12:00:00.000Z" }),
    ];
    expect(reusablePrivateChat({ botId: "luna1", links, shells, relayThreadIds: relays })).toBe(
      "empty-new",
    );
  });

  it("skips a chat whose turn or message is already on its shell", () => {
    const links = [link("luna1", "busy"), link("luna1", "sent")];
    const shells = [
      shell("busy", { latestTurn: { turnId: "t1" } as never }),
      shell("sent", { latestUserMessageAt: at }),
    ];
    expect(
      reusablePrivateChat({ botId: "luna1", links, shells, relayThreadIds: relays }),
    ).toBeNull();
  });
});

describe("addableBots", () => {
  it("offers enabled bots outside the group, by name", () => {
    const lunas = group("lunas", "Lunas", [["luna1", "relay-1"]]);
    const bots = [
      bot("zed", { name: "Zed" }),
      bot("luna1", { name: "Luna1" }),
      bot("off", { name: "Off", enabled: false }),
      bot("ada", { name: "Ada" }),
    ];
    expect(addableBots(bots, lunas).map((entry) => entry.name)).toEqual(["Ada", "Zed"]);
  });
});
