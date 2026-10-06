import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  PersonalBot,
  type PersonalBotThread,
  type PersonalRoutine,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { motionForSummary } from "./avatarMotion";
import { PERF_OFF_STORAGE_KEY, perfOptimizationOn } from "./perfFlags";
import {
  buildBotSummaries,
  botStatus,
  botStatusLine,
  type BotSummary,
  collectAttentionThreads,
  filterBotSummaries,
  isBotThinking,
  isThreadLive,
  isRateLimitStale,
  isThreadRateLimited,
  previewKeyAdvanced,
  previewRefreshKey,
  providerLine,
  resolveBotProvider,
  taskCardBotLine,
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
    // The fixture's time is when the chat last had activity (lists order by
    // that, see chatActivity.ts); `overrides` can move either one.
    createdAt: updatedAt,
    latestUserMessageAt: null,
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
      waitingByThread: new Map([["t-old", "Waiting on Developer"]]),
    });
    expect(waiting.find((summary) => summary.bot.name === "Assistant")?.waitingFor).toBe(
      "Waiting on Developer",
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

  it("counts a turn running in an archived chat: the row says Working, never Ready", () => {
    // QA on 30 Sep: its bug hunt was reopened in a chat auto-archive had put
    // away, and every visible chat was idle.
    const qa = [bot("qa", "QA", "codex", 0)];
    const qaLinks = [
      link("qa", "t-hunt", "2026-09-30T00:55:44.000Z"),
      link("qa", "t-idle"),
      link("qa", "t-put-away", "2026-09-29T10:00:00.000Z"),
    ];
    const hunt = shell("t-hunt", "2026-09-30T12:38:39.000Z", {
      latestTurn: { state: "running", assistantMessageId: "reply-1" },
      session: { status: "running" },
    });
    const qaShells = [
      hunt,
      shell("t-idle", "2026-09-30T09:00:00.000Z"),
      shell("t-put-away", "2026-09-29T09:00:00.000Z", {
        archivedAt: "2026-09-29T10:00:00.000Z",
      }),
    ];
    const [summary] = buildBotSummaries({
      bots: qa,
      links: qaLinks,
      shells: qaShells,
      providers: [provider("codex")],
      waitingByThread: new Map([["t-put-away", "Waiting on Developer"]]),
    });
    expect(summary!.live).toBe(true);
    expect(summary!.liveThread?.id).toBe("t-hunt");
    expect(botStatusLine(summary!, Date.parse("2026-09-30T13:00:00.000Z"))).toBe("Working");
    // Which chat the row opens and previews stays on the visible ones.
    expect(summary!.newestThread?.id).toBe("t-idle");
    expect(summary!.threadTitles).toEqual(["Thread t-idle"]);

    // Idle, the archived chat still says what the bot is waiting on.
    const [waiting] = buildBotSummaries({
      bots: qa,
      links: qaLinks,
      shells: qaShells.slice(1),
      providers: [provider("codex")],
      waitingByThread: new Map([["t-put-away", "Waiting on Developer"]]),
    });
    expect(waiting!.live).toBe(false);
    expect(botStatusLine(waiting!, Date.parse("2026-09-30T13:00:00.000Z"))).toBe(
      "Waiting on Developer",
    );
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

  describe("a rate limit that has passed", () => {
    const usageLimit = {
      kind: "rate_limited",
      provider: "codex",
      observedAt: "2026-10-02T17:21:00.000Z",
    };
    // QA's chat 0b372305: its task failed on a Codex usage limit, no reset time.
    const limitedChat = (overrides: Partial<Record<string, unknown>> = {}) =>
      shell("t-limited", "2026-10-02T17:21:00.000Z", {
        latestTurn: { state: "error", completedAt: "2026-10-02T17:21:00.000Z" },
        session: {
          status: "error",
          providerName: "codex",
          providerRetry: usageLimit,
          updatedAt: "2026-10-02T17:21:05.000Z",
        },
        ...overrides,
      });
    const repliedChat = (id: string, completedAt: string, providerName = "codex") =>
      shell(id, completedAt, {
        latestTurn: { state: "completed", completedAt },
        session: { status: "ready", providerName, updatedAt: completedAt },
      });
    const summarise = (
      shells: EnvironmentThreadShell[],
      endedTaskThreadIds?: ReadonlySet<string>,
      archived: string[] = [],
    ) =>
      buildBotSummaries({
        bots: [bots[1]!],
        links: shells.map((entry) =>
          link(
            "developer",
            entry.id,
            archived.includes(entry.id) ? "2026-10-02T19:00:00.000Z" : null,
          ),
        ),
        shells,
        providers: [provider("codex")],
        ...(endedTaskThreadIds === undefined ? {} : { endedTaskThreadIds }),
      })[0]!;
    const at = Date.parse("2026-10-02T19:49:00.000Z");

    it("shows the normal state once the bot has replied since, on the same provider", () => {
      const row = summarise([
        limitedChat(),
        repliedChat("t-ready", "2026-10-02T18:09:00.000Z"),
        repliedChat("t-ready-2", "2026-10-02T17:51:00.000Z"),
      ]);
      expect([row.rateLimited, row.rateLimitedThread]).toEqual([false, null]);
      expect(botStatusLine(row, at)).toBe("Ready");
      expect(motionForSummary(row)).toBe("idle");
      // An auto-archived reply still counts.
      const archived = summarise(
        [limitedChat(), repliedChat("t-ready", "2026-10-02T18:09:00.000Z")],
        undefined,
        ["t-ready"],
      );
      expect(archived.rateLimited).toBe(false);
    });

    it("still says rate limited when nothing has replied since the limit", () => {
      // A reply from before the limit proves nothing.
      const before = summarise([
        limitedChat(),
        repliedChat("t-before", "2026-10-02T17:00:00.000Z"),
      ]);
      expect(before.rateLimited).toBe(true);
      expect(botStatusLine(before, at)).toBe("Rate limited · reset not reported");
      expect(motionForSummary(before)).toBe("blocked");
      // Nor does a reply on another provider.
      const other = summarise([
        limitedChat(),
        repliedChat("t-claude", "2026-10-02T18:09:00.000Z", "claudeAgent"),
      ]);
      expect(other.rateLimited).toBe(true);
      // With a reset time the row says when.
      const timed = summarise([
        limitedChat({
          session: {
            status: "error",
            providerName: "codex",
            providerRetry: { ...usageLimit, retryAt: "2026-10-02T20:47:16.087Z" },
            updatedAt: "2026-10-02T17:21:05.000Z",
          },
        }),
      ]);
      expect(botStatusLine(timed, at)).toBe("Rate limited · retry ~21:47");
    });

    it("ignores the limit of a chat whose task ended, but not one still running", () => {
      const ended = new Set(["t-limited"]);
      const row = summarise([limitedChat()], ended);
      expect(row.rateLimited).toBe(false);
      expect(botStatusLine(row, at)).toBe("Ready");
      // A task that is still open keeps the row limited.
      expect(summarise([limitedChat()], new Set()).rateLimited).toBe(true);
      // A turn still waiting on the provider's clock is not stale, task or not.
      const running = limitedChat({
        latestTurn: { state: "running" },
        session: { status: "running", providerName: "codex", providerRetry: usageLimit },
      });
      expect(summarise([running], ended).rateLimited).toBe(true);
      expect(
        summarise([running, repliedChat("t-ready", "2026-10-02T18:09:00.000Z")], ended).rateLimited,
      ).toBe(true);
    });

    it("keeps another chat's live limit when only an old one is stale", () => {
      const fresh = shell("t-fresh", "2026-10-02T19:30:00.000Z", {
        latestTurn: { state: "error", completedAt: "2026-10-02T19:30:00.000Z" },
        session: {
          status: "error",
          providerName: "codex",
          providerRetry: { ...usageLimit, observedAt: "2026-10-02T19:30:00.000Z" },
          updatedAt: "2026-10-02T19:30:00.000Z",
        },
      });
      const row = summarise([
        limitedChat(),
        fresh,
        repliedChat("t-ready", "2026-10-02T18:09:00.000Z"),
      ]);
      expect(row.rateLimitedThread?.id).toBe("t-fresh");
    });

    describe("after the bot switched provider", () => {
      // QA, 5 Oct: chat 4e0bfa17 errored on a Codex limit that resets on 9 Oct;
      // QA now runs on Claude, and the Bots list kept saying "Rate limited".
      const codexLimit = {
        kind: "rate_limited",
        provider: "codex",
        observedAt: "2026-10-05T05:26:55.000Z",
        retryAt: "2026-10-09T21:10:43.000Z",
      };
      const qaChat = (overrides: Partial<Record<string, unknown>> = {}) =>
        shell("t-qa", "2026-10-05T05:26:55.000Z", {
          latestTurn: { state: "error", completedAt: "2026-10-05T05:26:55.000Z" },
          session: {
            status: "error",
            providerName: "codex",
            providerInstanceId: "codex",
            providerRetry: codexLimit,
            updatedAt: "2026-10-05T05:26:56.000Z",
          },
          ...overrides,
        });
      const claudeReply = (id: string, completedAt: string) =>
        shell(id, completedAt, {
          latestTurn: { state: "completed", completedAt },
          session: {
            status: "ready",
            providerName: "claudeAgent",
            providerInstanceId: "claudeAgent",
            updatedAt: completedAt,
          },
        });
      const qaRow = (
        instanceId: string,
        shells: EnvironmentThreadShell[],
        endedTaskThreadIds?: ReadonlySet<string>,
      ) =>
        buildBotSummaries({
          bots: [bot("qa", "QA", instanceId, 0)],
          links: shells.map((entry) => link("qa", entry.id)),
          shells,
          providers: [provider("codex"), provider("claudeAgent")],
          ...(endedTaskThreadIds === undefined ? {} : { endedTaskThreadIds }),
        })[0]!;
      const now = Date.parse("2026-10-05T12:00:00.000Z");

      it("shows no limit when the bot now runs on Claude, with a later Claude turn", () => {
        const row = qaRow("claudeAgent", [
          qaChat(),
          claudeReply("t-claude", "2026-10-05T10:00:00.000Z"),
        ]);
        expect([row.rateLimited, row.rateLimitedThread]).toEqual([false, null]);
        expect(botStatusLine(row, now)).toBe("Ready");
        expect(motionForSummary(row)).toBe("idle");
      });

      it("shows no limit when the bot now runs on Claude, with no later turn at all", () => {
        const row = qaRow("claudeAgent", [qaChat()]);
        expect([row.rateLimited, row.rateLimitedThread]).toEqual([false, null]);
        expect(botStatusLine(row, now)).toBe("Ready");
        // The chat itself still says what happened in it.
        expect(isThreadRateLimited(qaChat())).toBe(true);
      });

      it("keeps the limit of a bot still on the provider that was limited", () => {
        const row = qaRow("codex", [qaChat()]);
        expect(row.rateLimitedThread?.id).toBe("t-qa");
        expect(botStatusLine(row, now)).toMatch(/^Rate limited · retry ~/);
        expect(motionForSummary(row)).toBe("blocked");
        // A Claude reply in another chat does not clear a bot that is still on Codex.
        const replied = qaRow("codex", [
          qaChat(),
          claudeReply("t-claude", "2026-10-05T10:00:00.000Z"),
        ]);
        expect(replied.rateLimited).toBe(true);
      });

      it("matches a custom instance on the limited chat's driver, and an unnamed chat", () => {
        const custom = bot("qa", "QA", "codex_work", 0);
        const [row] = buildBotSummaries({
          bots: [custom],
          links: [link("qa", "t-qa")],
          shells: [qaChat()],
          providers: [provider("codex_work", { driver: "codex" } as Partial<ServerProvider>)],
        });
        expect(row!.rateLimited).toBe(true);
        // A chat that never named its provider says nothing against the limit.
        const unnamed = qaChat({
          session: { status: "error", providerRetry: { kind: "rate_limited" } },
        });
        expect(isRateLimitStale(unnamed, [unnamed], undefined, new Set(["claudeAgent"]))).toBe(
          false,
        );
      });

      it("only an errored chat can go stale this way: a turn still waiting keeps its limit", () => {
        const waiting = qaChat({
          latestTurn: { state: "running" },
          session: {
            status: "running",
            providerName: "codex",
            providerInstanceId: "codex",
            providerRetry: codexLimit,
          },
        });
        expect(qaRow("claudeAgent", [waiting]).rateLimited).toBe(true);
      });
    });

    it("falls back to the session time and tolerates missing fields", () => {
      const noObserved = limitedChat({
        session: {
          status: "error",
          providerName: "codex",
          providerRetry: { kind: "rate_limited", provider: "codex" },
          updatedAt: "2026-10-02T17:21:05.000Z",
        },
      });
      const replied = repliedChat("t-ready", "2026-10-02T18:09:00.000Z");
      expect(isRateLimitStale(noObserved, [noObserved, replied])).toBe(true);
      // No time to compare against: the limit stands.
      const noTimes = limitedChat({
        session: { status: "error", providerRetry: { kind: "rate_limited", provider: "codex" } },
      });
      expect(isRateLimitStale(noTimes, [noTimes, replied])).toBe(false);
    });
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
    // Thinking: live with nothing out of the turn yet. The needs-you states still win.
    expect(botStatusLine(summary({ live: true, thinking: true }), now)).toBe("Thinking");
    expect(botStatus(summary({ live: true, thinking: true }), now).tone).toBe("normal");
    expect(botStatusLine(summary({ live: false, thinking: true }), now)).not.toBe("Thinking");
    expect(
      botStatusLine(summary({ live: true, thinking: true, hasPendingApprovals: true }), now),
    ).toBe("Needs approval");
    expect(
      botStatusLine(summary({ live: true, thinking: true, needsBrowserHelp: true }), now),
    ).toBe("Needs your help");
    expect(botStatusLine(summary({ live: true, thinking: true, usingPc: true }), now)).toBe(
      "Using your PC",
    );

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
    expect(botStatusLine(summary({ waitingFor: "Waiting on Developer" }), now)).toBe(
      "Waiting on Developer",
    );
    // Waiting on a task is its own tone (a hollow ring), and never wins over a live turn.
    expect(botStatus(summary({ waitingFor: "Waiting on a task" }), now)).toEqual({
      label: "Waiting on a task",
      tone: "waiting",
    });
    expect(botStatus(summary({ waitingFor: "Waiting on a task", live: true }), now).label).toBe(
      "Working",
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

describe("previewKeyAdvanced", () => {
  const seg = (bot: string, fields: string) => `${bot}=${fields}`;
  const done = (thread: string, at: string) => `${thread},${at},turn-${thread},completed,msg,${at}`;

  it("counts a boundary moving on the same newest thread", () => {
    const before = seg("a", done("t1", "2026-09-01T10:00:00.000Z"));
    const after = seg("a", "t1,2026-09-01T10:05:00.000Z,turn-2,running,,");
    expect(previewKeyAdvanced(before, after)).toBe(true);
  });

  it("ignores the newest thread switching to one with no newer message (app open)", () => {
    const before = [seg("a", done("t1", "2026-09-22T18:50:00.000Z")), seg("b", "")].join("|");
    const after = [seg("a", "t9,,,,,"), seg("b", "")].join("|");
    expect(previewKeyAdvanced(before, after)).toBe(false);
  });

  it("counts a switch to a thread with a newer message", () => {
    const before = seg("a", done("t1", "2026-09-22T18:50:00.000Z"));
    const after = seg("a", "t2,2026-09-22T19:00:00.000Z,,,,");
    expect(previewKeyAdvanced(before, after)).toBe(true);
    expect(previewKeyAdvanced(seg("a", ""), after)).toBe(true);
  });

  it("does not depend on row order, and ignores bots appearing or leaving", () => {
    const a = seg("a", done("t1", "2026-09-22T18:50:00.000Z"));
    const b = seg("b", done("t2", "2026-09-22T18:40:00.000Z"));
    expect(previewKeyAdvanced([a, b].join("|"), [b, a].join("|"))).toBe(false);
    expect(previewKeyAdvanced(a, [a, b].join("|"))).toBe(false);
    expect(previewKeyAdvanced([a, b].join("|"), a)).toBe(false);
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

describe("list order follows conversation, not metadata writes", () => {
  // 28 Sep 20:10Z: upstream's auto-settle settled "Backend exercise set r2"
  // (last turn 25 Sep) and stamped its updatedAt; it jumped to the top as "Now".
  const bots = [bot("backend", "Backend", "codex", 0), bot("qa", "QA", "codex", 1)];
  const links = [link("backend", "t-bench"), link("backend", "t-live"), link("qa", "t-qa")];
  const benchShell = shell("t-bench", "2026-09-28T20:10:05.321Z", {
    createdAt: "2026-09-25T19:56:26.677Z",
    latestUserMessageAt: "2026-09-25T19:56:26.703Z",
    latestTurn: {
      state: "completed",
      requestedAt: "2026-09-25T19:56:26.703Z",
      startedAt: "2026-09-25T19:56:27.000Z",
      completedAt: "2026-09-25T20:09:17.316Z",
    },
  });

  it("keeps a settled 3-day-old chat where its last turn put it", () => {
    const summaries = buildBotSummaries({
      bots,
      links,
      shells: [
        benchShell,
        shell("t-live", "2026-09-27T09:00:00.000Z"),
        shell("t-qa", "2026-09-28T19:00:00.000Z"),
      ],
      providers: [provider("codex")],
    });
    expect(summaries.map((summary) => summary.bot.name)).toEqual(["QA", "Backend"]);
    const backend = summaries.find((summary) => summary.bot.name === "Backend")!;
    expect(backend.newestThread?.id).toBe("t-live");
    expect(backend.lastActivityMs).toBe(Date.parse("2026-09-27T09:00:00.000Z"));
  });

  it("takes the server's last message time, which a relay routine posts without a turn", () => {
    const relayed = {
      ...link("qa", "t-qa"),
      lastActivityAt: DateTime.makeUnsafe("2026-09-28T21:00:00.000Z"),
    } as unknown as PersonalBotThread;
    const summaries = buildBotSummaries({
      bots,
      links: [link("backend", "t-bench"), link("backend", "t-live"), relayed],
      shells: [
        benchShell,
        shell("t-live", "2026-09-28T20:30:00.000Z"),
        shell("t-qa", "2026-09-28T19:00:00.000Z"),
      ],
      providers: [provider("codex")],
    });
    expect(summaries[0]?.bot.name).toBe("QA");
    expect(summaries[0]?.lastActivityMs).toBe(Date.parse("2026-09-28T21:00:00.000Z"));
  });
});

describe("bot list row model label", () => {
  it("carries the short form the list row draws beside the name", () => {
    const opus = decodeBot({
      botId: "cto",
      name: "CTO",
      title: "Chief technology officer",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      enabled: true,
      sortOrder: 0,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
    const [summary] = buildBotSummaries({
      bots: [opus],
      links: [],
      shells: [],
      providers: [
        provider("claudeAgent", {
          models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false }],
        } as unknown as Partial<ServerProvider>),
      ],
    });
    expect(summary?.modelShortLabel).toBe("Opus 5.5 · H");
    // The full form stays for assistive text.
    expect(summary?.modelLabel).toBe("Opus 5.5 high");
  });
});

describe("taskCardBotLine", () => {
  const claude = provider("claudeAgent", {
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isCustom: false },
    ],
  } as unknown as Partial<ServerProvider>);

  const selection = (model: string, effort?: string) =>
    ({
      modelSelection: {
        instanceId: "claudeAgent",
        model,
        ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
      },
    }) as unknown as Pick<PersonalBot, "modelSelection">;

  it("shows the short model label instead of the provider name", () => {
    expect(taskCardBotLine(selection("claude-opus-5-5", "high"), [claude])).toBe("Opus 5.5 · H");
    expect(taskCardBotLine(selection("claude-sonnet-5-5", "medium"), [claude])).toBe(
      "Sonnet 5.5 · M",
    );
    expect(taskCardBotLine(selection("claude-sonnet-5-5"), [claude])).toBe("Sonnet 5.5");
  });

  it("falls back to the provider name only when no model is known", () => {
    expect(taskCardBotLine(selection(" "), [claude])).toBe("Claude Code");
  });

  it("is null when the bot is gone", () => {
    expect(taskCardBotLine(null, [claude])).toBeNull();
  });
});

describe("activity-memo kill switch (1.64.1)", () => {
  let stored: string | null = null;
  beforeEach(() => {
    stored = null;
    // The unit project has no DOM: a one-key stand-in for localStorage.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === PERF_OFF_STORAGE_KEY ? stored : null),
      setItem: (key: string, value: string) => {
        if (key === PERF_OFF_STORAGE_KEY) stored = value;
      },
      removeItem: () => {
        stored = null;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 7 bots, 60 chats of every kind: archived, busy, equal times, a link-only
  // time, a PC holder, a browser-help chat, a pending secret.
  const bots = Array.from({ length: 7 }, (_, index) =>
    bot(`b${index}`, `Bot ${index}`, "codex", index),
  );
  const links: PersonalBotThread[] = [];
  const shells: EnvironmentThreadShell[] = [];
  for (let index = 0; index < 60; index += 1) {
    const botId = `b${index % 7}`;
    const threadId = `t${index}`;
    const at = new Date(Date.UTC(2026, 9, 1, 8, index % 9, 0)).toISOString();
    links.push(
      index % 11 === 0
        ? link(botId, threadId, "2026-10-02T00:00:00.000Z")
        : index % 13 === 0
          ? ({
              ...link(botId, threadId),
              lastActivityAt: DateTime.makeUnsafe("2026-10-03T00:00:00.000Z"),
            } as unknown as PersonalBotThread)
          : link(botId, threadId),
    );
    shells.push(
      shell(threadId, at, {
        latestUserMessageAt: index % 5 === 0 ? at : null,
        hasPendingApprovals: index % 17 === 0,
        latestTurn:
          index % 4 === 0
            ? { state: "running", requestedAt: at, startedAt: at, completedAt: null }
            : null,
      }),
    );
  }
  const input = {
    bots,
    links,
    shells,
    providers: [provider("codex")],
    browserHelpThreadId: "t14",
    secretRequestThreadIds: new Set(["t3", "t10"]),
    desktop: { holderThreadId: "t5", waitingThreadIds: new Set(["t6", "t7"]) },
  };

  it("builds exactly the same rows with the memo and grouped links switched off", () => {
    const on = buildBotSummaries(input);
    expect(perfOptimizationOn("activity-memo")).toBe(true);
    globalThis.localStorage.setItem(PERF_OFF_STORAGE_KEY, "activity-memo");
    expect(perfOptimizationOn("activity-memo")).toBe(false);
    const off = buildBotSummaries(input);
    expect(off.map((summary) => summary.bot.botId)).toEqual(on.map((summary) => summary.bot.botId));
    for (const [position, summary] of on.entries()) {
      const other = off[position]!;
      expect({ ...summary, bot: summary.bot.botId }).toEqual({ ...other, bot: other.bot.botId });
    }
    expect(on.some((summary) => summary.needsSecret)).toBe(true);
    expect(on.some((summary) => summary.usingPc)).toBe(true);
    expect(on.some((summary) => summary.waitingForPc)).toBe(true);
    expect(on.some((summary) => summary.needsBrowserHelp)).toBe(true);
  });
});
