import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { PersonalBot, type PersonalBotThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildBotSummaries } from "./botSummaries";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const bot = decodeBot({
  botId: "dev",
  name: "Dev",
  title: "",
  description: "",
  instructions: "",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: "codex", model: "some-model" },
  enabled: true,
  sortOrder: 0,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
});

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const link = (threadId: string, extra: Record<string, unknown> = {}) =>
  ({
    botId: "dev",
    threadId,
    createdAt: iso(100),
    archivedAt: null,
    ...extra,
  }) as unknown as PersonalBotThread;
const shell = (id: string, hoursAgo: number) =>
  ({
    id,
    title: `Thread ${id}`,
    updatedAt: iso(hoursAgo),
    createdAt: iso(hoursAgo),
    latestUserMessageAt: null,
    archivedAt: null,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  }) as unknown as EnvironmentThreadShell;

const build = (links: PersonalBotThread[], nowMs: number) =>
  buildBotSummaries({
    bots: [bot],
    links,
    shells: [shell("fresh", 1), shell("older", 5)],
    providers: [],
    nowMs,
  })[0]!;

describe("buildBotSummaries and snoozed chats", () => {
  it("does not pick a snoozed chat as the bot's newest chat", () => {
    const summary = build(
      [link("fresh", { snoozedUntil: DateTime.makeUnsafe(NOW + 3_600_000) }), link("older")],
      NOW,
    );
    expect(summary.newestThread?.id).toBe("older");
    expect(summary.threadTitles).toEqual(["Thread older"]);
  });

  it("picks it again once its wake time has passed", () => {
    const links = [
      link("fresh", { snoozedUntil: DateTime.makeUnsafe(NOW + 3_600_000) }),
      link("older"),
    ];
    expect(build(links, NOW + 3_600_001).newestThread?.id).toBe("fresh");
  });

  it("a bot whose only chat is snoozed has no newest chat", () => {
    const summary = build(
      [link("fresh", { snoozedUntil: DateTime.makeUnsafe(NOW + 3_600_000) })],
      NOW,
    );
    expect(summary.newestThread).toBeNull();
  });
});
