import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  PersonalBot,
  type PersonalBotThread,
  type PersonalRoutine,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBotSummaries,
  botStatus,
  botStatusLine,
  type BotSummary,
  collectAttentionThreads,
  filterBotSummaries,
  isBotThinking,
  isThreadLive,
  isThreadRateLimited,
  previewRefreshKey,
  providerLine,
  resolveBotProvider,
} from "./botSummaries";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);

function bot(botId: string, name: string, instanceId: string, sortOrder: number) {
  return decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId, model: "some-model" },
    enabled: true,
    sortOrder,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

function link(botId: string, threadId: string, archivedAt: string | null = null) {
  return {
    botId,
    threadId,
    createdAt: "2026-09-01T10:00:00.000Z",
    archivedAt,
  } as unknown as PersonalBotThread;
}

function shell(
  id: string,
  updatedAt: string,
  overrides: Partial<Record<string, unknown>> = {},
): EnvironmentThreadShell {
  return {
    id,
    title: `Thread ${id}`,
    updatedAt,
    archivedAt: null,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId,
    driver: instanceId,
    enabled: true,
    ...overrides,
  } as unknown as ServerProvider;
}

describe("resolveBotProvider", () => {
  it("names a live instance and flags a missing or unavailable one", () => {
    const providers = [provider("codex"), provider("claudeAgent", { availability: "unavailable" })];
    expect(resolveBotProvider("codex", providers)).toEqual({
      label: "Codex",
      available: true,
      broken: false,
    });
    expect(providerLine(resolveBotProvider("claudeAgent", providers))).toMatch(/· unavailable$/);
    expect(resolveBotProvider("gone_instance", providers)).toEqual({
      label: "Gone Instance",
      available: false,
      broken: false,
    });
  });
});

describe("buildBotSummaries", () => {
  const bots = [
    bot("assistant", "Assistant", "codex", 0),
    bot("developer", "Developer", "codex", 1),
    bot("planner", "Planner", "codex", 2),
  ];
  const links = [
    link("assistant", "t-old"),
    link("assistant", "t-new"),
    link("developer", "t-dev"),
    link("developer", "t-archived", "2026-09-10T10:00:00.000Z"),
  ];
  const shells = [
    shell("t-old", "2026-09-13T08:00:00.000Z"),
    shell("t-new", "2026-09-13T09:00:00.000Z", { latestTurn: { state: "running" } }),
    shell("t-dev", "2026-09-13T12:00:00.000Z", { hasPendingApprovals: true }),
    shell("t-archived", "2026-09-13T13:00:00.000Z"),
  ];
  const summaries = buildBotSummaries({ bots, links, shells, providers: [provider("codex")] });

  it("says which bot a parked thread waits for, and nothing otherwise", () => {
    const waiting = buildBotSummaries({
      bots,
      links,
      shells,
      providers: [provider("codex")],
      waitingByThread: new Map([["t-old", "Waiting for Developer"]]),
    });
    expect(waiting.find((summary) => summary.bot.name === "Assistant")?.waitingFor).toBe(
      "Waiting for Developer",
    );
    expect(waiting.find((summary) => summary.bot.name === "Developer")?.waitingFor).toBeNull();
    expect(summaries.every((summary) => summary.waitingFor === null)).toBe(true);
  });

  it("orders by latest activity, bots without threads last", () => {
    expect(summaries.map((summary) => summary.bot.name)).toEqual([
      "Developer",
      "Assistant",
      "Planner",
    ]);
  });

  it("derives newest thread, live state and attention from real shells", () => {
    const assistant = summaries.find((summary) => summary.bot.name === "Assistant")!;
    expect(assistant.newestThread?.id).toBe("t-new");
    expect(assistant.live).toBe(true);
    expect(assistant.attentionThreads).toHaveLength(0);

    const developer = summaries.find((summary) => summary.bot.name === "Developer")!;
    expect(developer.live).toBe(false);
    expect(developer.threadTitles).toEqual(["Thread t-dev"]);
    expect(collectAttentionThreads(summaries).map((thread) => thread.id)).toEqual(["t-dev"]);

    const planner = summaries.find((summary) => summary.bot.name === "Planner")!;
    expect(planner.newestThread).toBeNull();
    expect(planner.lastActivityMs).toBeNull();
  });

  it("shows a thread parked on a rate limit as rate limited, not live", () => {
    const wait = (kind: "rate_limited" | "retrying") => ({
      kind,
      provider: "claudeAgent",
      observedAt: "2026-09-13T03:47:16.087Z",
    });
    const limited = shell("t-wait", "2026-09-13T09:00:00.000Z", {
      latestTurn: { state: "running" },
      session: { status: "running", providerRetry: wait("rate_limited") },
    });
    const [summary] = buildBotSummaries({
      bots: [bots[0]!],
      links: [link("assistant", "t-wait")],
      shells: [limited],
      providers: [provider("codex")],
    });
    expect([summary!.live, summary!.rateLimited]).toEqual([false, true]);

    // A failed turn keeps its rate limit; a transport retry is still work in progress.
    const failed = shell("t-failed", "2026-09-13T09:00:00.000Z", {
      session: { status: "error", providerRetry: wait("rate_limited") },
    });
    const retrying = shell("t-retry", "2026-09-13T09:00:00.000Z", {
      session: { status: "running", providerRetry: wait("retrying") },
    });
    expect([isThreadLive(failed), isThreadRateLimited(failed)]).toEqual([false, true]);
    expect([isThreadLive(retrying), isThreadRateLimited(retrying)]).toEqual([true, false]);
  });

  it("links browser help and the next enabled scheduled routine to their bot", () => {
    const routine = {
      routineId: "routine-1",
      botId: bots[0]!.botId,
      trigger: "schedule",
      enabled: true,
      nextDueAt: DateTime.makeUnsafe("2026-09-14T08:00:00.000Z"),
      timeZone: "Europe/London",
    } as PersonalRoutine;
    const [summary] = buildBotSummaries({
      bots: [bots[0]!],
      links: [link("assistant", "t-old")],
      shells: [shell("t-old", "2026-09-13T08:00:00.000Z")],
      providers: [provider("codex")],
      browserHelpThreadId: "t-old",
      routines: [routine],
    });

    expect(summary?.needsBrowserHelp).toBe(true);
    expect(summary?.nextRoutine).toBe(routine);
  });

  it("links a pending secret request to its bot through the chat it was asked in", () => {
    const build = (threadIds: ReadonlySet<string>) =>
      buildBotSummaries({
        bots: [bots[0]!],
        links: [link("assistant", "t-old")],
        shells: [shell("t-old", "2026-09-13T08:00:00.000Z")],
        providers: [provider("codex")],
        secretRequestThreadIds: threadIds,
      })[0];

    expect(build(new Set(["t-old"]))?.needsSecret).toBe(true);
    // A request in another bot's chat is not this bot's business.
    expect(build(new Set(["t-elsewhere"]))?.needsSecret).toBe(false);
  });

  it("searches bot names and thread titles", () => {
    expect(filterBotSummaries(summaries, "plan").map((summary) => summary.bot.name)).toEqual([
      "Planner",
    ]);
    expect(filterBotSummaries(summaries, "t-old").map((summary) => summary.bot.name)).toEqual([
      "Assistant",
    ]);
    expect(filterBotSummaries(summaries, "  ")).toHaveLength(3);
  });
});

describe("buildBotSummaries previews", () => {
  it("takes the newest message of the newest thread from the list, never a subscription", () => {
    const newest = { id: "m2", role: "assistant" as const, text: "Done." };
    const summaries = buildBotSummaries({
      bots: [bot("assistant", "Assistant", "codex", 0)],
      links: [
        { ...link("assistant", "t-old"), newestMessage: { id: "m1", role: "user", text: "Hi" } },
        { ...link("assistant", "t-new"), newestMessage: newest },
        { ...link("assistant", "t-none") },
      ] as unknown as PersonalBotThread[],
      shells: [
        shell("t-old", "2026-09-13T08:00:00.000Z"),
        shell("t-new", "2026-09-13T09:00:00.000Z"),
        shell("t-none", "2026-09-13T07:00:00.000Z"),
      ],
      providers: [provider("codex")],
    });
    expect(summaries[0]?.newestThread?.id).toBe("t-new");
    expect(summaries[0]?.newestMessage).toEqual(newest);
  });
});

describe("botStatusLine", () => {
  const [ready] = buildBotSummaries({
    bots: [bot("assistant", "Assistant", "codex", 0)],
    links: [link("assistant", "thread-a")],
    shells: [shell("thread-a", "2026-09-13T09:00:00.000Z")],
    providers: [provider("codex")],
  });
  const summary = (overrides: Partial<BotSummary> = {}): BotSummary => ({
    ...ready!,
    ...overrides,
  });
  const now = Date.parse("2026-09-13T04:00:00.000Z");

  it("covers every status branch in priority order", () => {
    expect(
      botStatusLine(
        summary({
          needsBrowserHelp: true,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          live: true,
        }),
        now,
      ),
    ).toBe("Needs your help");
    // Above approvals and questions: only answering or declining frees the task.
    expect(botStatusLine(summary({ needsSecret: true, hasPendingApprovals: true }), now)).toBe(
      "Needs a secret",
    );
    expect(botStatusLine(summary({ hasPendingApprovals: true }), now)).toBe("Needs approval");
    expect(botStatusLine(summary({ hasPendingUserInput: true }), now)).toBe("Needs your reply");
    expect(botStatusLine(summary({ live: true }), now)).toBe("Working");

    const limited = shell("limited", "2026-09-13T09:00:00.000Z", {
      session: {
        status: "error",
        providerRetry: {
          kind: "rate_limited",
          provider: "codex",
          observedAt: "2026-09-13T03:47:16.087Z",
          retryAt: "2026-09-13T09:47:16.087Z",
        },
      },
    });
    expect(botStatusLine(summary({ rateLimitedThread: limited }), now)).toBe(
      "Rate limited · retry ~10:47",
    );
    expect(botStatusLine(summary({ waitingFor: "Waiting for Developer" }), now)).toBe(
      "Waiting for Developer",
    );

    const routine = {
      botId: ready!.bot.botId,
      trigger: "schedule",
      enabled: true,
      nextDueAt: DateTime.makeUnsafe("2026-09-14T08:00:00.000Z"),
      timeZone: "Europe/London",
    } as PersonalRoutine;
    expect(botStatusLine(summary({ nextRoutine: routine }), now)).toBe(
      "Next run Mon 14 Sep, 09:00",
    );
    expect(
      botStatusLine(
        summary({ provider: { label: "Codex", available: false, broken: false } }),
        now,
      ),
    ).toBe("Unavailable · tap to fix");
    expect(botStatusLine(summary(), now)).toBe("Ready");
  });

  it("uses the review tone for needs-you and actionable unavailable states", () => {
    expect(botStatus(summary({ needsBrowserHelp: true }), now).tone).toBe("review");
    expect(botStatus(summary({ hasPendingApprovals: true }), now).tone).toBe("review");
    expect(botStatus(summary({ hasPendingUserInput: true }), now).tone).toBe("review");
    expect(
      botStatus(summary({ provider: { label: "Codex", available: false, broken: false } }), now)
        .tone,
    ).toBe("review");
    expect(botStatus(summary({ live: true }), now).tone).toBe("normal");
  });
});

describe("previewRefreshKey", () => {
  const bots = [bot("bot-a", "Ada", "codex", 0)];
  const keyFor = (overrides: Partial<Record<string, unknown>>) =>
    previewRefreshKey(
      buildBotSummaries({
        bots,
        links: [link("bot-a", "t1")],
        shells: [shell("t1", "2026-09-01T10:00:00.000Z", overrides)],
        providers: [provider("codex")],
      }),
    );
  const running = {
    turnId: "turn-1",
    state: "running",
    requestedAt: "2026-09-01T10:00:00.000Z",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: null,
    assistantMessageId: "msg-1",
  };

  it("ignores streamed chunks, which only move the shell's updatedAt", () => {
    const first = keyFor({ latestTurn: running });
    const later = previewRefreshKey(
      buildBotSummaries({
        bots,
        links: [link("bot-a", "t1")],
        shells: [shell("t1", "2026-09-01T10:00:09.500Z", { latestTurn: running })],
        providers: [provider("codex")],
      }),
    );
    expect(later).toBe(first);
  });

  it("moves on a new owner message, a new assistant message and turn settlement", () => {
    const base = keyFor({ latestTurn: running });
    expect(
      keyFor({ latestTurn: running, latestUserMessageAt: "2026-09-01T10:01:00.000Z" }),
    ).not.toBe(base);
    expect(keyFor({ latestTurn: { ...running, assistantMessageId: "msg-2" } })).not.toBe(base);
    expect(
      keyFor({
        latestTurn: { ...running, state: "completed", completedAt: "2026-09-01T10:02:00.000Z" },
      }),
    ).not.toBe(base);
  });
});

describe("isBotThinking", () => {
  const running = (turnId: string, assistantMessageId: string | null) => ({
    session: { status: "running", activeTurnId: turnId },
    latestTurn: { turnId, state: "running", assistantMessageId },
  });

  it("thinks while a live turn has produced no reply yet", () => {
    expect(isBotThinking([shell("a", "2026-09-13T09:00:00.000Z", running("t1", null))])).toBe(true);
  });

  it("works once the turn's first assistant message arrives", () => {
    expect(isBotThinking([shell("a", "2026-09-13T09:00:00.000Z", running("t1", "m1"))])).toBe(
      false,
    );
  });

  it("works when any live thread is producing, and ignores idle threads", () => {
    expect(
      isBotThinking([
        shell("a", "2026-09-13T09:00:00.000Z", running("t1", null)),
        shell("b", "2026-09-13T09:00:00.000Z", running("t2", "m2")),
      ]),
    ).toBe(false);
    expect(
      isBotThinking([
        shell("a", "2026-09-13T09:00:00.000Z", running("t1", null)),
        shell("b", "2026-09-13T09:00:00.000Z"),
      ]),
    ).toBe(true);
  });

  it("is false for a bot with nothing running", () => {
    expect(isBotThinking([shell("a", "2026-09-13T09:00:00.000Z")])).toBe(false);
    expect(isBotThinking([])).toBe(false);
  });

  it("feeds the summary", () => {
    const [summary] = buildBotSummaries({
      bots: [bot("assistant", "Assistant", "codex", 0)],
      links: [link("assistant", "thread-a")],
      shells: [shell("thread-a", "2026-09-13T09:00:00.000Z", running("t1", null))],
      providers: [provider("codex")],
    });
    expect(summary?.live).toBe(true);
    expect(summary?.thinking).toBe(true);
  });
});
