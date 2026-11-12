import { describe, expect, it } from "vite-plus/test";

import { partitionPinnedSummaries, type BotSummary } from "./botSummaries.ts";

/** `partitionPinnedSummaries` only reads the bot and the working flags, the rest of the summary is noise. */
const summary = (
  botId: string,
  bot: { team?: "dev" | "assistant"; lead?: boolean; pinned?: boolean; pinOrder?: number } = {},
  state: { live?: boolean; lastActivityMs?: number | null } = {},
) =>
  ({
    bot: { botId, name: botId, ...bot },
    live: state.live ?? false,
    lastActivityMs: state.lastActivityMs ?? null,
  }) as unknown as BotSummary;

const idsOf = (summaries: ReadonlyArray<BotSummary>) =>
  summaries.map((entry) => entry.bot.botId as string);

describe("partitionPinnedSummaries", () => {
  it("follows the saved pin order, not who worked last", () => {
    const { pinned } = partitionPinnedSummaries([
      summary("third", { pinned: true, pinOrder: 2 }, { live: true, lastActivityMs: 90 }),
      summary("first", { pinned: true, pinOrder: 0 }),
      summary("second", { pinned: true, pinOrder: 1 }, { lastActivityMs: 50 }),
    ]);

    expect(idsOf(pinned)).toEqual(["first", "second", "third"]);
  });

  it("breaks an equal pin order by bot id", () => {
    const { pinned } = partitionPinnedSummaries([
      summary("zeta", { pinned: true, pinOrder: 1 }),
      summary("alpha", { pinned: true, pinOrder: 1 }),
    ]);

    expect(idsOf(pinned)).toEqual(["alpha", "zeta"]);
  });

  it("does not move when activity changes", () => {
    const before = partitionPinnedSummaries([
      summary("first", { pinned: true, pinOrder: 0 }),
      summary("second", { pinned: true, pinOrder: 1 }),
    ]);
    const after = partitionPinnedSummaries([
      summary("first", { pinned: true, pinOrder: 0 }),
      summary("second", { pinned: true, pinOrder: 1 }, { live: true, lastActivityMs: 100 }),
    ]);

    expect(idsOf(after.pinned)).toEqual(idsOf(before.pinned));
  });

  it("puts an old server's pins with no order last, by team rank", () => {
    const { pinned } = partitionPinnedSummaries([
      summary("assistant", { lead: true, pinned: true }),
      summary("ordered", { pinned: true, pinOrder: 4 }),
      summary("cto", { team: "dev", lead: true, pinned: true }),
    ]);

    expect(idsOf(pinned)).toEqual(["ordered", "cto", "assistant"]);
  });

  it("lists each bot on exactly one side of the split", () => {
    const summaries = [
      summary("cto", { team: "dev", lead: true, pinned: true, pinOrder: 0 }),
      summary("frontend", { team: "dev" }),
      summary("scout"),
    ];

    const { pinned, rest } = partitionPinnedSummaries(summaries);

    expect(idsOf(pinned)).toEqual(["cto"]);
    expect(idsOf(rest)).toEqual(["frontend", "scout"]);
  });

  it("pins nothing when nothing is pinned", () => {
    const summaries = [summary("scout"), summary("planner")];

    const { pinned, rest } = partitionPinnedSummaries(summaries);

    expect(pinned).toEqual([]);
    expect(idsOf(rest)).toEqual(["scout", "planner"]);
  });
});
