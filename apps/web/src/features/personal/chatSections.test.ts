import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBot, PersonalBotThread, PersonalGroup } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildChatSections, plainGroups, sectionRowMatches } from "./chatSections";

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const hours = (h: number) => DateTime.makeUnsafe(NOW + h * 3_600_000);
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const bots = [
  { botId: "dev", name: "Dev" },
  { botId: "hidden", name: "Hidden", groupOnly: true },
] as unknown as PersonalBot[];

const link = (threadId: string, extra: Record<string, unknown> = {}, botId = "dev") =>
  ({ botId, threadId, archivedAt: null, ...extra }) as unknown as PersonalBotThread;
const shell = (id: string, activityHours: number, extra: Record<string, unknown> = {}) =>
  ({
    id,
    title: `Title ${id}`,
    createdAt: iso(activityHours),
    updatedAt: iso(activityHours),
    latestUserMessageAt: null,
    latestTurn: null,
    archivedAt: null,
    ...extra,
  }) as unknown as EnvironmentThreadShell;
const group = (groupId: string, updatedHours: number, extra: Record<string, unknown> = {}) =>
  ({
    groupId,
    name: `Group ${groupId}`,
    members: [],
    updatedAt: hours(updatedHours),
    archivedAt: null,
    ...extra,
  }) as unknown as PersonalGroup;

function sections(input: {
  links?: PersonalBotThread[];
  shells?: EnvironmentThreadShell[];
  groups?: PersonalGroup[];
  relays?: string[];
}) {
  return buildChatSections({
    bots,
    links: input.links ?? [],
    shells: input.shells ?? [],
    groups: input.groups ?? [],
    relayThreadIds: new Set(input.relays ?? []),
    nowMs: NOW,
  });
}

describe("buildChatSections", () => {
  it("lists no pinned chat or group: a pin shows in the bot's own chat list", () => {
    const out = sections({
      links: [link("a", { pinnedAt: hours(-50) }), link("b", { pinnedAt: hours(-40) }), link("c")],
      shells: [shell("a", -5), shell("b", -1), shell("c", -2)],
      groups: [group("g1", -3, { pinnedAt: hours(-30) }), group("g2", -2)],
    });
    expect(out.snoozed).toEqual([]);
    expect("pinned" in out).toBe(false);
  });

  it("lists snoozed chats and groups by soonest wake, and a snoozed pinned chat only there", () => {
    const out = sections({
      links: [
        link("a", { snoozedUntil: hours(5) }),
        link("b", { snoozedUntil: hours(2), pinnedAt: hours(-9) }),
      ],
      shells: [shell("a", -5), shell("b", -1)],
      groups: [group("g1", -3, { snoozedUntil: hours(3) })],
    });
    expect(out.snoozed.map((row) => row.key)).toEqual(["b", "g1", "a"]);
    expect(out.snoozed[0]?.wakeMs).toBe(NOW + 2 * 3_600_000);
  });

  it("a group snooze that has run out is awake again", () => {
    const out = sections({ groups: [group("g1", -3, { snoozedUntil: hours(-1) })] });
    expect(out.snoozed).toEqual([]);
  });

  it("leaves out archived chats, relays, group-only bots, chats with no shell and archived shells", () => {
    const asleep = { snoozedUntil: hours(3) };
    const out = sections({
      links: [
        link("archived", { ...asleep, archivedAt: hours(-1) }),
        link("relay", asleep),
        link("hidden", asleep, "hidden"),
        link("no-shell", asleep),
        link("shell-archived", asleep),
        link("ok", asleep),
      ],
      shells: [
        shell("archived", -1),
        shell("relay", -1),
        shell("hidden", -1),
        shell("shell-archived", -1, { archivedAt: iso(-1) }),
        shell("ok", -1),
      ],
      relays: ["relay"],
    });
    expect(out.snoozed.map((row) => row.key)).toEqual(["ok"]);
  });
});

describe("plainGroups", () => {
  it("keeps the groups that are awake, pinned or not (a group has no bot chat list to pin in)", () => {
    const groups = [
      group("plain", -1),
      group("pinned", -1, { pinnedAt: hours(-5) }),
      group("asleep", -1, { snoozedUntil: hours(4) }),
      group("woken", -1, { snoozedUntil: hours(-4) }),
    ];
    expect(plainGroups(groups, NOW).map((entry) => entry.groupId)).toEqual([
      "plain",
      "pinned",
      "woken",
    ]);
  });
});

describe("sectionRowMatches", () => {
  const out = sections({
    links: [link("a", { snoozedUntil: hours(2) })],
    shells: [shell("a", -1)],
    groups: [group("g1", -1, { snoozedUntil: hours(2) })],
  });
  const names = () => ["Ada"];

  it("matches a chat on its title or its bot, a group on its name or members", () => {
    const [chat, grp] = [
      out.snoozed.find((row) => row.kind === "chat")!,
      out.snoozed.find((row) => row.kind === "group")!,
    ];
    expect(sectionRowMatches(chat, "title a", names)).toBe(true);
    expect(sectionRowMatches(chat, "dev", names)).toBe(true);
    expect(sectionRowMatches(chat, "nope", names)).toBe(false);
    expect(sectionRowMatches(grp, "group g1", names)).toBe(true);
    expect(sectionRowMatches(grp, "ada", names)).toBe(true);
    expect(sectionRowMatches(grp, "", names)).toBe(true);
    expect(sectionRowMatches(grp, "zzz", names)).toBe(false);
  });
});
