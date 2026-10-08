import type {
  PersonalBot,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageTotals,
  PersonalBotTokenUsageWindow,
} from "@t3tools/contracts";
import type { ReactTestInstance } from "react-test-renderer";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TokenUsageCard } from "./TokenUsageSection";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: never }) => (
    <a {...rest} data-to={to as string} data-params={JSON.stringify(params)}>
      {children}
    </a>
  ),
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

const bot = (botId: string, name: string): PersonalBot =>
  ({ botId, name, title: "", avatarShape: "blob", avatarColor: "#1A73E8" }) as never;
const BOTS = [
  bot("cto", "CTO"),
  bot("backend", "Backend"),
  bot("qa", "QA"),
  bot("designer", "Designer"),
  bot("watcher", "Watcher"),
];
const LISTED = new Set(BOTS.map((b) => b.botId as string));
const LABELS = new Map<string, string | null>([
  ["cto", "Opus 5.5 · M"],
  ["backend", "Sonnet 5.5 · H"],
]);

const totals = (out: number, cached = 0, input = 0): PersonalBotTokenUsageTotals => ({
  uncachedInputTokens: input,
  cachedInputTokens: cached,
  cacheCreationTokens: 0,
  outputTokens: out,
});

function windowOf(
  id: PersonalBotTokenUsageWindow["id"],
  rows: ReadonlyArray<[string, PersonalBotTokenUsageTotals]>,
  other: PersonalBotTokenUsageTotals,
): PersonalBotTokenUsageWindow {
  const all = [...rows.map(([, t]) => t), other];
  const add = (pick: (t: PersonalBotTokenUsageTotals) => number) =>
    all.reduce((n, t) => n + pick(t), 0);
  return {
    id,
    sinceDay: id === "today" ? "2026-10-04" : id === "week" ? "2026-09-28" : "2026-09-05",
    untilDay: "2026-10-04",
    rows: rows.map(([botId, t]) => ({ botId, totals: t, models: [], sessions: 2 }) as never),
    providers: [],
    other: { totals: other, costUsd: 0, unpricedTokens: 0, sessions: 1 },
    total: {
      costUsd: 0,
      unpricedTokens: 0,
      totals: {
        uncachedInputTokens: add((t) => t.uncachedInputTokens),
        cachedInputTokens: add((t) => t.cachedInputTokens),
        cacheCreationTokens: add((t) => t.cacheCreationTokens),
        outputTokens: add((t) => t.outputTokens),
      },
      sessions: rows.length + 1,
    },
  };
}

const READY: PersonalBotTokenUsageResult = {
  status: "ready",
  readAt: new Date(NOW - 3 * 60_000).toISOString(),
  windows: [
    windowOf("today", [["backend", totals(2_000_000, 8_000_000, 1_000_000)]], totals(0)),
    windowOf(
      "week",
      [
        ["qa", totals(1_000_000, 30_000_000, 1_000_000)],
        ["cto", totals(5_000_000, 100_000_000, 15_400_000)],
        ["backend", totals(3_000_000, 60_000_000, 2_000_000)],
        ["designer", totals(500_000, 4_000_000, 500_000)],
      ],
      totals(100_000, 800_000, 100_000),
    ),
    windowOf("month", [["cto", totals(9_000_000, 400_000_000, 30_000_000)]], totals(1_000_000)),
  ],
};

/** The week window with providers and prices: Claude fully priced, GPT / Codex partly and not at all. */
const PRICED: PersonalBotTokenUsageResult = {
  ...READY,
  windows: READY.windows.map((window) => {
    if (window.id !== "week") return window;
    const cost: Record<string, { costUsd: number; unpricedTokens: number }> = {
      cto: { costUsd: 210.5, unpricedTokens: 0 },
      backend: { costUsd: 18.25, unpricedTokens: 5_000_000 },
      qa: { costUsd: 0, unpricedTokens: 32_000_000 },
      designer: { costUsd: 12.34, unpricedTokens: 0 },
    };
    const claudeTotals = totals(
      5_000_000 + 500_000 + 100_000,
      100_000_000 + 4_000_000 + 800_000,
      15_400_000 + 500_000 + 100_000,
    );
    const codexTotals = totals(
      1_000_000 + 3_000_000,
      30_000_000 + 60_000_000,
      1_000_000 + 2_000_000,
    );
    return {
      ...window,
      rows: window.rows.map((row) => ({ ...row, ...cost[row.botId as string] })),
      providers: [
        // Codex first in the payload on purpose: the card sorts by tokens.
        {
          provider: "codex",
          totals: codexTotals,
          costUsd: 18.25,
          unpricedTokens: 37_000_000,
          sessions: 4,
        },
        {
          provider: "claude",
          totals: claudeTotals,
          costUsd: 223.74,
          unpricedTokens: 0,
          sessions: 6,
        },
      ],
      other: { ...window.other, costUsd: 0.9, unpricedTokens: 0 },
      total: { ...window.total, costUsd: 241.99, unpricedTokens: 37_000_000 },
    } as unknown as PersonalBotTokenUsageWindow;
  }),
};

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const render = async (
  props: Partial<Parameters<typeof TokenUsageCard>[0]> = {},
): Promise<ReactTestRenderer> => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <TokenUsageCard
        result={READY}
        error={null}
        onRetry={() => undefined}
        bots={BOTS}
        listedBotIds={LISTED}
        modelLabels={LABELS}
        nowMs={NOW}
        {...props}
      />,
    );
  });
  return renderer!;
};

const rowsOf = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll((node) => node.type === "a" && node.props["data-bot-usage-row"] !== undefined);
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const radios = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.type === "button" && node.props.role === "radio");
const byTestId = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((node) => node.props["data-testid"] === id);

describe("TokenUsageCard", () => {
  it("opens on 7 days with the three ranges as 44 px buttons, one chosen", async () => {
    const tree = await render();
    const buttons = radios(tree);
    expect(buttons.map(textOf)).toEqual(["Today", "7 days", "30 days"]);
    expect(buttons.map((b) => b.props["aria-checked"])).toEqual([false, true, false]);
    for (const button of buttons) expect(button.props.className).toContain("min-h-11");
    expect(textOf(tree.root.findByType("h2"))).toBe("Token usage");
  });

  it("lists the bots from most to fewest tokens, every listed bot included", async () => {
    const tree = await render();
    const names = rowsOf(tree).map((row) => row.props["data-bot-usage-row"]);
    expect(names).toEqual(["cto", "backend", "qa", "designer", "watcher"]);
  });

  it("shows the headline total and the in / cached / out split, which add up", async () => {
    const tree = await render();
    const cto = rowsOf(tree)[0]!;
    const text = textOf(cto);
    // 5.0M out + 100.0M cached + 15.4M in = 120.4M
    expect(text).toContain("120.4M");
    expect(text).toContain("in 15.4M · cached 100.0M · out 5.0M");
    expect(text).toContain("CTO");
    expect(text).toContain("Opus 5.5 · M");
    // 120.4M of the 222.4M the bots used in the week
    expect(text).toContain("54%");
  });

  it("gives the top three a rank chip and a strong bar, and nobody else", async () => {
    const tree = await render();
    const rows = rowsOf(tree);
    const chips = rows.map((row) =>
      row.findAll((n) => n.props["data-testid"] === "token-usage-rank").map(textOf),
    );
    expect(chips).toEqual([["1"], ["2"], ["3"], [], []]);
    const bars = rows.map(
      (row) =>
        row.findAll((n) => n.props["data-testid"] === "token-usage-bar")[0]!.props
          .className as string,
    );
    expect(bars[0]).toContain("bg-[var(--personal-primary)]");
    expect(bars[2]).toContain("bg-[var(--personal-primary)]");
    expect(bars[3]).not.toContain("bg-[var(--personal-primary)]");
    // The bar is 3 px high.
    expect(
      rows[0]!.findAll((n) => n.props.className?.toString().includes("h-[3px]")).length,
    ).toBeGreaterThan(0);
  });

  it("sizes each bar to the bot's share, and draws none for a bot with no use", async () => {
    const tree = await render();
    const widths = rowsOf(tree).map(
      (row) =>
        row.findAll((n) => n.props["data-testid"] === "token-usage-bar")[0]!.props.style.width,
    );
    expect(Number.parseFloat(widths[0])).toBeCloseTo(53.9, 0);
    expect(Number.parseFloat(widths[0])).toBeGreaterThan(Number.parseFloat(widths[1]));
    expect(widths[4]).toBe("0%");
    const watcher = textOf(rowsOf(tree)[4]!);
    expect(watcher).toContain("Watcher");
    expect(watcher).toContain("No use in this period");
    expect(watcher).toContain("0%");
  });

  it("opens the bot like the diagram does, so Back returns to the Team screen", async () => {
    const tree = await render();
    const first = rowsOf(tree)[0]!;
    expect(first.props["data-to"]).toBe("/bots/$botId");
    expect(JSON.parse(first.props["data-params"])).toEqual({ botId: "cto" });
    expect(first.props["aria-label"]).toContain("Number 1 user");
    expect(first.props.className).toContain("min-h-[60px]");
  });

  it("leaves the owner's work outside the bots out of every bot's share and bar", async () => {
    // 30 days: CTO is the only bot, Outside Bots is 1.0M of the 440.0M total.
    const tree = await render();
    await act(async () => radios(tree)[2]!.props.onClick());
    const cto = rowsOf(tree)[0]!;
    expect(textOf(cto)).toContain("100%");
    const bar = cto.findAll((n) => n.props["data-testid"] === "token-usage-bar")[0]!;
    expect(bar.props.style.width).toBe("100%");
  });

  it("switches the window and recounts every row from it", async () => {
    const tree = await render();
    await act(async () => radios(tree)[0]!.props.onClick());
    expect(radios(tree).map((b) => b.props["aria-checked"])).toEqual([true, false, false]);
    expect(textOf(tree.root.findByProps({ "data-testid": "token-usage-total" }))).toBe("11.0M");
    const first = rowsOf(tree)[0]!;
    expect(first.props["data-bot-usage-row"]).toBe("backend");
    expect(textOf(tree.root.findByType("section"))).toContain("4 Oct");

    await act(async () => radios(tree)[2]!.props.onClick());
    expect(rowsOf(tree)[0]!.props["data-bot-usage-row"]).toBe("cto");
    expect(textOf(tree.root.findByProps({ "data-testid": "token-usage-total" }))).toBe("440.0M");
    expect(textOf(tree.root.findByType("section"))).toContain("5 Sep to 4 Oct");
  });

  it("ends with Outside Bots, the total and when it was updated", async () => {
    const tree = await render();
    const text = textOf(tree.root.findByType("section"));
    expect(text).toContain("Outside Bots");
    expect(text).toContain("your own Claude Code and older sessions");
    expect(text).not.toContain("not attributed");
    expect(textOf(tree.root.findByProps({ "data-testid": "token-usage-outside" }))).toBe("1.0M");
    expect(text).toContain("Total");
    expect(textOf(tree.root.findByProps({ "data-testid": "token-usage-total" }))).toBe("223.4M");
    expect(textOf(tree.root.findByProps({ "data-testid": "token-usage-updated" }))).toBe(
      "Updated 3m ago",
    );
  });

  it("says a stale snapshot is being refreshed while it still shows the numbers", async () => {
    const tree = await render({ result: { ...READY, status: "refreshing" } });
    expect(rowsOf(tree)).toHaveLength(5);
    expect(textOf(tree.root.findByProps({ "data-testid": "token-usage-updated" }))).toBe(
      "Updated 3m ago · Updating…",
    );
    expect(tree.root.findByType("section").props["aria-busy"]).toBe(true);
  });

  it("says the count is running when the server has no snapshot yet", async () => {
    const tree = await render({ result: { status: "warming", readAt: null, windows: [] } });
    expect(rowsOf(tree)).toHaveLength(0);
    expect(textOf(tree.root.findByType("section"))).toContain("Counting tokens");
    // The ranges are there and work while it counts.
    expect(radios(tree)).toHaveLength(3);
  });

  it("offers a retry when the count failed or the read did", async () => {
    const onRetry = vi.fn();
    const failed = await render({
      result: { status: "unavailable", readAt: null, windows: [] },
      onRetry,
    });
    const retry = failed.root.findAll((n) => n.type === "button" && textOf(n) === "Try again");
    expect(retry).toHaveLength(1);
    expect(retry[0]!.props.className).toContain("h-11");
    await act(async () => retry[0]!.props.onClick());
    expect(onRetry).toHaveBeenCalledOnce();

    await act(async () => failed.unmount());
    const errored = await render({ result: null, error: "No such method", onRetry });
    expect(textOf(errored.root.findByType("section"))).toContain("Couldn't load token usage.");
    expect(
      errored.root.findAll((n) => n.type === "button" && textOf(n) === "Try again"),
    ).toHaveLength(1);
  });

  it("says so when nothing was used in the period, and still lists the team", async () => {
    const empty: PersonalBotTokenUsageResult = {
      status: "ready",
      readAt: new Date(NOW).toISOString(),
      windows: ["today", "week", "month"].map((id) =>
        windowOf(id as PersonalBotTokenUsageWindow["id"], [], totals(0)),
      ),
    };
    const tree = await render({ result: empty });
    expect(textOf(tree.root.findByType("section"))).toContain("No bot used tokens in this period.");
    expect(rowsOf(tree)).toHaveLength(5);
    expect(byTestId(tree, "token-usage-rank")).toHaveLength(0);
  });

  describe("by provider and the API price estimate", () => {
    const providerRows = (tree: ReactTestRenderer) =>
      tree.root.findAll(
        (n) => n.props["data-provider-usage-row"] !== undefined && n.type === "div",
      );

    it("puts the provider block under the range switch and above the bot rows", async () => {
      const tree = await render({ result: PRICED });
      const text = textOf(tree.root.findByType("section"));
      expect(text.indexOf("By provider")).toBeGreaterThan(text.indexOf("30 days"));
      expect(text.indexOf("By provider")).toBeLessThan(text.indexOf("By bot"));
      expect(text.indexOf("By bot")).toBeLessThan(text.indexOf("CTO"));
    });

    it("lists each provider with tokens, share and estimate, most tokens first", async () => {
      const tree = await render({ result: PRICED });
      const rows = providerRows(tree);
      expect(rows.map((row) => row.props["data-provider-usage-row"])).toEqual(["claude", "codex"]);
      const claude = textOf(rows[0]!);
      expect(claude).toContain("Claude");
      expect(claude).toContain("126.4M");
      expect(claude).toContain("$223.74");
      expect(claude).toContain("57%");
      const codex = textOf(rows[1]!);
      expect(codex).toContain("GPT / Codex");
      expect(codex).toContain("97.0M");
      expect(codex).toContain("$18.25 + unpriced");
      expect(codex).toContain("43%");
      expect(rows[0]!.props["aria-label"]).toBe(
        "Claude: 126.4M tokens, 57% of all use, estimated cost $223.74.",
      );
    });

    it("adds the providers up to the same total the bot table ends with", async () => {
      const tree = await render({ result: PRICED });
      const providersTotal = textOf(byTestId(tree, "token-usage-providers-total")[0]!);
      expect(providersTotal).toContain("All providers");
      expect(providersTotal).toContain("223.4M");
      expect(providersTotal).toContain("$241.99 + unpriced");
      expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("223.4M");
    });

    it("says the estimate is a list-price estimate, not money charged", async () => {
      const tree = await render({ result: PRICED });
      const note = textOf(byTestId(tree, "token-usage-price-note")[0]!);
      expect(note).toContain("API price estimate");
      expect(note).toContain("list API prices");
      expect(note).toContain("not money charged");
      expect(note).toContain("subscriptions are flat");
    });

    it("shows the estimate under each bot's share: priced, part priced, not priced, none", async () => {
      const tree = await render({ result: PRICED });
      const costOf = (botId: string) =>
        rowsOf(tree)
          .find((row) => row.props["data-bot-usage-row"] === botId)!
          .findAll((n) => n.props["data-testid"] === "token-usage-row-cost")
          .map(textOf);
      expect(costOf("cto")).toEqual(["$210.50"]);
      expect(costOf("backend")).toEqual(["$18.25+"]);
      expect(costOf("qa")).toEqual(["not priced"]);
      expect(costOf("designer")).toEqual(["$12.34"]);
      // Listed but unused: no estimate to show.
      expect(costOf("watcher")).toEqual([]);
      const cto = rowsOf(tree).find((row) => row.props["data-bot-usage-row"] === "cto")!;
      expect(cto.props["aria-label"]).toContain("Estimated cost $210.50.");
    });

    it("keeps the right column the width it was", async () => {
      const tree = await render({ result: PRICED });
      const cto = rowsOf(tree).find((row) => row.props["data-bot-usage-row"] === "cto")!;
      const column = cto.findAll((n) => n.props.className?.toString().includes("w-[64px]"));
      expect(column).toHaveLength(1);
    });

    it("gives Outside Bots and the total their own estimate", async () => {
      const tree = await render({ result: PRICED });
      expect(textOf(byTestId(tree, "token-usage-outside-cost")[0]!)).toBe("$0.90");
      expect(textOf(byTestId(tree, "token-usage-total-cost")[0]!)).toBe("$241.99+");
    });

    it("shows no provider block, note or estimate for a window the server sent none for", async () => {
      const tree = await render({ result: PRICED });
      await act(async () => radios(tree)[0]!.props.onClick());
      expect(byTestId(tree, "token-usage-providers")).toHaveLength(0);
      expect(byTestId(tree, "token-usage-price-note")).toHaveLength(0);
      expect(textOf(tree.root.findByType("section"))).not.toContain("By bot");
      expect(byTestId(tree, "token-usage-row-cost")).toHaveLength(0);
    });
  });
});
