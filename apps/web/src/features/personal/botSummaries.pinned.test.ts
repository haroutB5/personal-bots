import { describe, expect, it } from "vite-plus/test";

import { partitionPinnedSummaries, type BotSummary } from "./botSummaries";

/** `partitionPinnedSummaries` only reads the bot, so the rest of the summary is noise here. */
const summary = (
  botId: string,
  bot: { team?: "dev" | "assistant"; lead?: boolean; pinned?: boolean } = {},
) => ({ bot: { botId, name: botId, ...bot } }) as unknown as BotSummary;

const idsOf = (summaries: ReadonlyArray<BotSummary>) =>
  summaries.map((entry) => entry.bot.botId as string);

describe("partitionPinnedSummaries", () => {
  it("puts the two leads first, CTO before Assistant", () => {
    const { pinned } = partitionPinnedSummaries([
      summary("assistant", { lead: true, pinned: true }),
      summary("musey", { pinned: true }),
      summary("cto", { team: "dev", lead: true, pinned: true }),
    ]);

    // Leads by team order, then the rest in the order the list already had.
    expect(idsOf(pinned)).toEqual(["cto", "assistant", "musey"]);
  });

  it("lists each bot on exactly one side of the split", () => {
    const summaries = [
      summary("cto", { team: "dev", lead: true, pinned: true }),
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
