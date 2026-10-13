import type {
  PersonalBot,
  PersonalBotThread,
  PersonalGroup,
  PersonalGroupRound,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeRows,
  cardCaption,
  chatRowPreview,
  filterHomeRows,
  homeChatBases,
  isChatRowLive,
  railBots,
  railCaption,
  railCards,
  searchHomeRows,
  visibleHomeRows,
  type HomeRowsInput,
} from "./homeRows";
import type { BotSummary } from "./botSummaries";
import { deriveNeedsYou, type NeedsYouModel } from "./needsYou";
import { NO_CHAT_SEEN } from "./unreadChats";

const bot = (botId: string, name: string, extra: Partial<PersonalBot> = {}) =>
  ({
    botId,
    name,
    title: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    sortOrder: 0,
    lead: false,
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    ...extra,
  }) as unknown as PersonalBot;

const link = (
  threadId: string,
  botId: string,
  extra: Partial<PersonalBotThread> = {},
): PersonalBotThread =>
  ({
    botId,
    threadId,
    createdAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    ...extra,
  }) as unknown as PersonalBotThread;

const shell = (
  id: string,
  activityAt: string,
  extra: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell =>
  ({
    id,
    updatedAt: activityAt,
    createdAt: activityAt,
    latestUserMessageAt: null,
    latestTurn: null,
    archivedAt: null,
    title: id,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...extra,
  }) as unknown as EnvironmentThreadShell;

const group = (groupId: string, name: string, extra: Partial<PersonalGroup> = {}) =>
  ({
    groupId,
    name,
    description: "",
    threadId: `thread-${groupId}`,
    maxBotTurns: 6,
    members: [{ botId: "bot-juno" }, { botId: "bot-chef" }],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    ...extra,
  }) as unknown as PersonalGroup;

const round = (groupId: string, status: PersonalGroupRound["status"]) =>
  ({
    roundId: `r-${groupId}`,
    groupId,
    status,
    activeThreadId: null,
  }) as unknown as PersonalGroupRound;

const EMPTY_NEEDS: NeedsYouModel = { byRow: new Map(), all: [], count: 0 };

const input = (
  overrides: Partial<Omit<HomeRowsInput, "needsYou">> & { needsYou?: NeedsYouModel } = {},
): HomeRowsInput => ({
  bots: [],
  links: [],
  shells: [],
  groups: [],
  rounds: [],
  relayThreadIds: new Set(),
  needsYou: EMPTY_NEEDS,
  nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
  seen: NO_CHAT_SEEN,
  ...overrides,
});

describe("homeChatBases", () => {
  it("lists open, awake chats and skips archived ones, relays and chats without a shell", () => {
    const bases = homeChatBases(
      input({
        bots: [bot("b1", "Juno")],
        links: [
          link("open", "b1"),
          link("archived", "b1", { archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
          link("relay", "b1"),
          link("gone", "b1"),
          link("snoozed", "b1", { snoozedUntil: DateTime.makeUnsafe("2026-10-03T00:00:00.000Z") }),
        ],
        shells: [
          shell("open", "2026-10-02T11:00:00.000Z"),
          shell("archived", "2026-10-01T00:00:00.000Z"),
          shell("relay", "2026-10-02T10:00:00.000Z"),
          shell("snoozed", "2026-10-02T10:00:00.000Z"),
        ],
        relayThreadIds: new Set(["relay"]),
      }),
    );
    expect(bases.map((base) => base.key)).toEqual(["open"]);
    expect(bases[0]!.title).toBe("open");
    expect(bases[0]!.bot.name).toBe("Juno");
  });

  it("carries the chat's own unread flag and pin", () => {
    const bases = homeChatBases(
      input({
        bots: [bot("b1", "Juno")],
        links: [
          link("u", "b1", {
            unread: true,
            lastReplyAt: DateTime.makeUnsafe("2026-10-02T11:00:00.000Z"),
          }),
          link("p", "b1", { pinnedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
        ],
        shells: [shell("u", "2026-10-02T11:00:00.000Z"), shell("p", "2026-10-02T10:00:00.000Z")],
      }),
    );
    const byKey = new Map(bases.map((base) => [base.key, base]));
    expect(byKey.get("u")?.unread).toBe(true);
    expect(byKey.get("p")?.pinned).toBe(true);
  });
});

describe("buildHomeRows", () => {
  it("interleaves chats and groups by last activity", () => {
    const rows = buildHomeRows({
      chatBases: homeChatBases(
        input({
          bots: [bot("b1", "Juno")],
          links: [link("newest", "b1"), link("oldest", "b1")],
          shells: [
            shell("newest", "2026-10-02T11:59:00.000Z"),
            shell("oldest", "2026-10-02T09:00:00.000Z"),
          ],
        }),
      ),
      groups: [
        group("g1", "Saturday plans", {
          updatedAt: DateTime.makeUnsafe("2026-10-02T11:30:00.000Z"),
        } as never),
      ],
      rounds: [],
      needsYou: EMPTY_NEEDS,
      nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
    });
    expect(rows.map((row) => row.key)).toEqual(["newest", "g1", "oldest"]);
    expect(rows[1]!.kind).toBe("group");
  });

  it("leaves a snoozed group out of the rows", () => {
    const rows = buildHomeRows({
      chatBases: [],
      groups: [
        group("g1", "Snoozed", {
          snoozedUntil: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
        } as never),
      ],
      rounds: [],
      needsYou: EMPTY_NEEDS,
      nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
    });
    expect(rows).toHaveLength(0);
  });

  it("joins each row's own request from the needs-you model", () => {
    const needsYou = deriveNeedsYou({
      threads: [{ threadId: "t1", botId: "b1", shell: { hasPendingUserInput: true } }],
      secretRequests: [],
      loginRequests: [],
      browserHelpThreadId: null,
      approvalThreadIds: new Set(),
      groupIds: new Set(["g1"]),
      rounds: [round("g1", "paused_vote")],
    });
    const rows = buildHomeRows({
      chatBases: homeChatBases(
        input({
          bots: [bot("b1", "Juno")],
          links: [link("t1", "b1")],
          shells: [shell("t1", "2026-10-02T11:00:00.000Z")],
        }),
      ),
      groups: [group("g1", "Plans")],
      rounds: [round("g1", "paused_vote")],
      needsYou,
      nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("t1")?.request?.kind).toBe("answer");
    expect(byKey.get("g1")?.request?.kind).toBe("vote");
  });
});

describe("filterHomeRows", () => {
  const rows = buildHomeRows({
    chatBases: homeChatBases(
      input({
        bots: [bot("b1", "Juno")],
        links: [
          link("plain", "b1"),
          link("pinned", "b1", { pinnedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
          link("unread", "b1", {
            unread: true,
            lastReplyAt: DateTime.makeUnsafe("2026-10-02T11:00:00.000Z"),
          }),
          link("asking", "b1"),
        ],
        shells: [
          shell("plain", "2026-10-02T11:00:00.000Z"),
          shell("pinned", "2026-10-02T10:30:00.000Z"),
          shell("unread", "2026-10-02T10:00:00.000Z"),
          shell("asking", "2026-10-02T09:00:00.000Z", { hasPendingUserInput: true }),
        ],
      }),
    ),
    groups: [group("g1", "Plans")],
    rounds: [round("g1", "paused_vote")],
    needsYou: deriveNeedsYou({
      threads: [
        { threadId: "asking", botId: "b1", shell: { hasPendingUserInput: true } },
        { threadId: "pinned", botId: "b1", shell: { hasPendingApprovals: true } },
      ],
      secretRequests: [],
      loginRequests: [],
      browserHelpThreadId: null,
      approvalThreadIds: new Set(),
      groupIds: new Set(["g1"]),
      rounds: [round("g1", "paused_vote")],
    }),
    nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
  });

  it("All leaves the pinned chats out: they are in the rail", () => {
    expect(filterHomeRows(rows, "all").map((row) => row.key)).toEqual([
      "plain",
      "unread",
      "asking",
      "g1",
    ]);
  });

  it("Needs you includes pinned chats and counts its rows as the model does", () => {
    const needs = filterHomeRows(rows, "needs");
    expect(needs.map((row) => row.key)).toEqual(["pinned", "asking", "g1"]);
    expect(needs).toHaveLength(3);
  });

  it("Unread is the chats' (a group carries no unread flag)", () => {
    expect(filterHomeRows(rows, "unread").map((row) => row.key)).toEqual(["unread"]);
  });

  it("Groups is the group rows", () => {
    expect(filterHomeRows(rows, "groups").map((row) => row.key)).toEqual(["g1"]);
  });
});

describe("visibleHomeRows", () => {
  const rows = buildHomeRows({
    chatBases: homeChatBases(
      input({
        bots: [bot("b1", "Juno"), bot("b2", "Pilot")],
        links: [link("lisbon", "b1"), link("dinner", "b2")],
        shells: [
          shell("lisbon", "2026-10-02T11:00:00.000Z", { title: "Weekend in Lisbon" }),
          shell("dinner", "2026-10-02T10:00:00.000Z", { title: "Dinners this week" }),
        ],
      }),
    ),
    groups: [group("g1", "Saturday plans")],
    rounds: [],
    needsYou: EMPTY_NEEDS,
    nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
  });
  const nameOf = (botId: string) =>
    botId === "bot-juno" ? "Juno" : botId === "bot-chef" ? "Chef" : null;

  it("a search reaches every row, ignoring the filter chip", () => {
    expect(
      visibleHomeRows({ rows, filter: "groups", query: "lisbon", nameOf }).map((row) => row.key),
    ).toEqual(["lisbon"]);
  });

  it("a search matches a group by its members' names", () => {
    expect(
      visibleHomeRows({ rows, filter: "all", query: "chef", nameOf }).map((row) => row.key),
    ).toEqual(["g1"]);
  });

  it("no search: the filter decides", () => {
    expect(
      visibleHomeRows({ rows, filter: "all", query: "", nameOf }).map((row) => row.key),
    ).toEqual(["lisbon", "dinner", "g1"]);
  });
});

describe("searchHomeRows", () => {
  it("matches a chat's title and its bot's name", () => {
    const rows = buildHomeRows({
      chatBases: homeChatBases(
        input({
          bots: [bot("b1", "Juno")],
          links: [link("t1", "b1")],
          shells: [shell("t1", "2026-10-02T11:00:00.000Z", { title: "Weekend in Lisbon" })],
        }),
      ),
      groups: [],
      rounds: [],
      needsYou: EMPTY_NEEDS,
      nowMs: 0,
    });
    expect(searchHomeRows(rows, "lisbon", () => "Juno")).toHaveLength(1);
    expect(searchHomeRows(rows, "juno", () => "Juno")).toHaveLength(1);
    expect(searchHomeRows(rows, "prado", () => "Juno")).toHaveLength(0);
  });
});

describe("railCards and railBots", () => {
  it("orders the rail's cards by activity, newest first", () => {
    const rows = buildHomeRows({
      chatBases: homeChatBases(
        input({
          bots: [bot("b1", "Juno")],
          links: [
            link("p-old", "b1", { pinnedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
            link("p-new", "b1", { pinnedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z") }),
            link("unpinned", "b1"),
          ],
          shells: [
            shell("p-old", "2026-10-02T08:00:00.000Z"),
            shell("p-new", "2026-10-02T11:00:00.000Z"),
            shell("unpinned", "2026-10-02T11:30:00.000Z"),
          ],
        }),
      ),
      groups: [
        group("g1", "Plans", {
          pinnedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        } as never),
      ],
      rounds: [],
      needsYou: EMPTY_NEEDS,
      nowMs: Date.parse("2026-10-02T12:00:00.000Z"),
    });
    expect(railCards(rows).map((row) => row.key)).toEqual(["p-new", "p-old", "g1"]);
  });

  const summary = (
    name: string,
    activityMs: number | null,
    extra: Partial<BotSummary> = {},
  ): BotSummary =>
    ({
      bot: bot(`bot-${name}`, name),
      lastActivityMs: activityMs,
      modelShortLabel: "Sonnet 5.5 · M",
      live: false,
      thinking: false,
      attentionThreads: [],
      ...extra,
    }) as unknown as BotSummary;

  it("orders the rail's bots: pinned first, then by activity", () => {
    const pinned = summary("Pinned", 100, { bot: bot("bot-pinned", "Pinned", { pinned: true }) });
    const bots = railBots([summary("Quiet", 200), summary("Busy", 900), pinned]);
    expect(bots.map((entry) => entry.bot.name)).toEqual(["Pinned", "Busy", "Quiet"]);
  });

  it("sorts a bot with no activity last, then by the bot order", () => {
    const bots = railBots([
      summary("Never", null),
      summary("Talked", 500),
      summary("Never2", null),
    ]);
    expect(bots.map((entry) => entry.bot.name)).toEqual(["Talked", "Never", "Never2"]);
  });
});

describe("captions", () => {
  const summary = (extra: Partial<BotSummary>): BotSummary =>
    ({
      bot: bot("b1", "Forge"),
      live: false,
      thinking: false,
      modelShortLabel: "Opus 5.5",
      attentionThreads: [],
      ...extra,
    }) as unknown as BotSummary;

  it("a rail tile says the state in words, in the state's colour", () => {
    expect(
      railCaption({ summary: summary({ live: true }), now: 0, needsYou: false, thinking: false }),
    ).toEqual({ label: "Working", tone: "working" });
    expect(
      railCaption({
        summary: summary({ live: true, thinking: true }),
        now: 0,
        needsYou: false,
        thinking: true,
      }),
    ).toEqual({ label: "Thinking", tone: "thinking" });
    expect(railCaption({ summary: summary({}), now: 0, needsYou: true, thinking: false })).toEqual({
      label: "Needs you",
      tone: "needs",
    });
  });

  it("an idle tile shows the model family", () => {
    expect(railCaption({ summary: summary({}), now: 0, needsYou: false, thinking: false })).toEqual(
      {
        label: "Opus 5.5",
        tone: "idle",
      },
    );
  });

  it("a pinned card says Needs you, else Working or the bot's model", () => {
    const request = {
      kind: "answer" as const,
      key: "t1",
      threadId: "t1",
      botId: "b1",
      requestId: null,
    };
    const row = {
      kind: "chat" as const,
      key: "t1",
      request,
    } as never;
    expect(
      cardCaption({ row, tone: "plain", live: false, round: null, modelLabel: "Opus 5.5" }),
    ).toEqual({ label: "Needs you", tone: "needs" });
    const plainRow = { kind: "chat" as const, key: "t1", request: null } as never;
    expect(
      cardCaption({
        row: plainRow,
        tone: "working",
        live: true,
        round: null,
        modelLabel: "Opus 5.5",
      }),
    ).toEqual({ label: "Working", tone: "working" });
    expect(
      cardCaption({
        row: plainRow,
        tone: "plain",
        live: false,
        round: null,
        modelLabel: "Opus 5.5",
      }),
    ).toEqual({ label: "Opus 5.5", tone: "idle" });
  });
});

describe("chatRowPreview", () => {
  const row = (extra: Partial<PersonalBotThread> = {}, botExtra: Partial<PersonalBot> = {}) =>
    ({
      kind: "chat",
      key: "t1",
      link: link("t1", "b1", extra),
      shell: shell("t1", "2026-10-02T11:00:00.000Z"),
      bot: bot("b1", "Juno", botExtra),
      title: "Weekend in Lisbon",
      activityMs: Date.parse("2026-10-02T11:00:00.000Z"),
      unread: false,
      pinned: false,
      request: null,
    }) as never;

  it("shows the newest message's first plain line", () => {
    const preview = chatRowPreview({
      row: row({
        newestMessage: { id: "m1", role: "assistant", text: "## VERDICT\nAll good." } as never,
      }),
      thinking: false,
    });
    expect(preview).toEqual({ text: "VERDICT", tone: "plain" });
  });

  it("shows the working line and its tone while a turn runs", () => {
    const live = {
      ...(row() as Record<string, unknown>),
      shell: shell("t1", "2026-10-02T11:00:00.000Z", {
        latestTurn: { turnId: "turn-1", state: "running" },
      } as never),
    } as never;
    expect(
      chatRowPreview({ row: live, progressNote: "Running the suite", thinking: true }),
    ).toEqual({
      text: "Running the suite",
      tone: "working",
    });
    expect(chatRowPreview({ row: live, progressNote: null, thinking: true })).toEqual({
      text: "Thinking",
      tone: "thinking",
    });
    expect(chatRowPreview({ row: live, progressNote: null, thinking: false })).toEqual({
      text: "Working",
      tone: "working",
    });
  });

  it("never shows message words when the bot hides previews", () => {
    const hidden = row(
      { newestMessage: { id: "m1", role: "assistant", text: "", hidden: true } as never },
      { hidePreviews: true } as never,
    );
    expect(chatRowPreview({ row: hidden, thinking: false }).text).toBe("Preview hidden");
  });

  it("says so when a chat has no messages yet", () => {
    expect(chatRowPreview({ row: row(), thinking: false })).toEqual({
      text: "No messages yet",
      tone: "plain",
    });
  });
});

describe("isChatRowLive", () => {
  it("counts a running turn and a running or starting session", () => {
    expect(
      isChatRowLive({
        shell: shell("t", "x", { latestTurn: { turnId: "1", state: "running" } } as never),
      }),
    ).toBe(true);
    expect(
      isChatRowLive({ shell: shell("t", "x", { session: { status: "starting" } } as never) }),
    ).toBe(true);
    expect(
      isChatRowLive({ shell: shell("t", "x", { session: { status: "idle" } } as never) }),
    ).toBe(false);
  });
});
