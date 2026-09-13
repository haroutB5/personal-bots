import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { PersonalBot, type PersonalBotThread, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBotSummaries,
  collectAttentionThreads,
  filterBotSummaries,
  isThreadLive,
  isThreadRateLimited,
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
    expect(resolveBotProvider("codex", providers)).toEqual({ label: "Codex", available: true });
    expect(providerLine(resolveBotProvider("claudeAgent", providers))).toMatch(/· unavailable$/);
    expect(resolveBotProvider("gone_instance", providers)).toEqual({
      label: "Gone Instance",
      available: false,
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
