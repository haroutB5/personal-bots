import type {
  PersonalBot,
  PersonalBotTokenUsageModel,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageTotals,
  PersonalBotTokenUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import type { ReactTestInstance } from "react-test-renderer";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Sheet } from "~/components/ui/sheet";

import { TokenUsageCard } from "./TokenUsageSection";

vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; onOpenChange?: unknown; children: ReactNode }) =>
    open ? <div data-slot="sheet">{children}</div> : null,
  SheetPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetClose: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

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
const MODEL_NAMES = new Map<string, string>([
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["deepseek-flash", "DeepSeek V4.1 Flash"],
]);

const totals = (out: number, cached = 0, input = 0): PersonalBotTokenUsageTotals => ({
  uncachedInputTokens: input,
  cachedInputTokens: cached,
  cacheCreationTokens: 0,
  outputTokens: out,
});

const modelUsage = (
  provider: UsageProviderKind,
  model: string,
  t: PersonalBotTokenUsageTotals,
  costUsd = 0,
  unpricedTokens = 0,
): PersonalBotTokenUsageModel => ({ provider, model, totals: t, costUsd, unpricedTokens });

function windowOf(
  id: PersonalBotTokenUsageWindow["id"],
  rows: ReadonlyArray<
    [string, PersonalBotTokenUsageTotals, ReadonlyArray<PersonalBotTokenUsageModel>?]
  >,
  other: PersonalBotTokenUsageTotals,
): PersonalBotTokenUsageWindow {
  const all = [...rows.map(([, t]) => t), other];
  const add = (pick: (t: PersonalBotTokenUsageTotals) => number) =>
    all.reduce((n, t) => n + pick(t), 0);
  return {
    id,
    sinceDay: id === "today" ? "2026-10-04" : id === "week" ? "2026-09-28" : "2026-09-05",
    untilDay: "2026-10-04",
    rows: rows.map(
      ([botId, t, models]) => ({ botId, totals: t, models: models ?? [], sessions: 2 }) as never,
    ),
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
        [
          "cto",
          totals(5_000_000, 100_000_000, 15_400_000),
          [
            modelUsage("claude", "claude-opus-5-5", totals(4_000_000, 90_000_000, 10_000_000), 200),
            modelUsage(
              "deepseek",
              "deepseek-flash",
              totals(1_000_000, 10_000_000, 5_400_000),
              10.5,
            ),
          ],
        ],
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
        modelNames={MODEL_NAMES}
        nowMs={NOW}
        {...props}
      />,
    );
  });
  return renderer!;
};

const rowsOf = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll(
    (node) => node.type === "button" && node.props["data-bot-usage-row"] !== undefined,
  );
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const radios = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.type === "button" && node.props.role === "radio");
const byTestId = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((node) => node.props["data-testid"] === id);

const clickable = (node: ReactTestInstance) => node.props.onClick as () => void;
const sheetOf = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.props["data-slot"] === "sheet");
const sheetText = (tree: ReactTestRenderer): string => textOf(sheetOf(tree)[0]!);
const providerRows = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => n.props["data-provider-usage-row"] !== undefined && n.type === "li");

/** A week where CTO used one model only. */
const SINGLE: PersonalBotTokenUsageResult = {
  ...READY,
  windows: READY.windows.map((window) =>
    window.id === "week"
      ? windowOf(
          "week",
          [
            [
              "cto",
              totals(1_000, 9_000, 2_000),
              [modelUsage("claude", "claude-opus-5-5", totals(1_000, 9_000, 2_000), 4.2)],
            ],
          ],
          totals(0),
        )
      : window,
  ),
};

describe("TokenUsageCard", () => {
  it("opens on 7 days with the three ranges as 44 px buttons, one chosen", async () => {
    const tree = await render();
    const buttons = radios(tree);
    expect(buttons.map(textOf)).toEqual(["Today", "7 days", "30 days"]);
    expect(buttons.map((b) => b.props["aria-checked"])).toEqual([false, true, false]);
    for (const button of buttons) expect(button.props.className).toContain("min-h-11");
    expect(textOf(tree.root.findByType("h2"))).toBe("Token usage");
  });

  it("shows the span the range covers in the header", async () => {
    const tree = await render();
    expect(textOf(byTestId(tree, "token-usage-span")[0]!)).toBe("28 Sep – 4 Oct");
    await act(async () => clickable(radios(tree)[0]!)());
    expect(textOf(byTestId(tree, "token-usage-span")[0]!)).toBe("4 Oct");
  });

  it("lists the bots with use from most to fewest tokens, as buttons, and folds the rest", async () => {
    const tree = await render();
    const names = rowsOf(tree).map((row) => row.props["data-bot-usage-row"]);
    expect(names).toEqual(["cto", "backend", "qa", "designer"]);
    for (const row of rowsOf(tree)) {
      expect(row.props.className).toContain("min-h-16");
      expect(row.props["aria-haspopup"]).toBe("dialog");
    }
    // The bot with no use is one line, not a row.
    expect(textOf(byTestId(tree, "token-usage-idle")[0]!)).toBe("No use: Watcher");
  });

  it("opens the tapped bot's sheet through onOpenBot, and does not navigate", async () => {
    const onOpenBot = vi.fn();
    const tree = await render({ onOpenBot });
    await act(async () => clickable(rowsOf(tree)[1]!)());
    expect(onOpenBot).toHaveBeenCalledExactlyOnceWith("backend");
    expect(rowsOf(tree)[0]!.props["aria-label"]).toBe(
      "CTO, 120.4M tokens, 54% of bots. Show models",
    );
  });

  it("shows the headline total and its tokens split, which add up", async () => {
    const tree = await render();
    expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("223.4M");
    expect(textOf(byTestId(tree, "token-usage-split")[0]!)).toBe(
      "in 19.0M · cached 194.8M (91%) · out 9.6M",
    );
  });

  it("shows models and share on each row, and the top three get a rank chip", async () => {
    const tree = await render();
    const rows = rowsOf(tree);
    expect(
      textOf(rows[0]!.findAll((n) => n.props["data-testid"] === "token-usage-row-meta")[0]!),
    ).toBe("2 models · 54%");
    const chips = rows.map((row) =>
      row.findAll((n) => n.props["data-testid"] === "token-usage-rank").map(textOf),
    );
    expect(chips).toEqual([["1"], ["2"], ["3"], []]);
  });

  it("sizes each bar against the heaviest bot", async () => {
    const tree = await render();
    const widths = rowsOf(tree).map((row) =>
      Number.parseFloat(
        row.findAll((n) => n.props["data-testid"] === "token-usage-bar")[0]!.props.style.width,
      ),
    );
    expect(widths[0]).toBe(100);
    expect(widths[1]).toBeCloseTo((65 / 120.4) * 100, 0);
    expect(widths[0]).toBeGreaterThan(widths[1]!);
  });

  it("puts Outside Bots after the bots, not tappable, with its own tokens", async () => {
    const tree = await render();
    const text = textOf(tree.root.findByType("section"));
    expect(text).toContain("Outside Bots");
    expect(text).toContain("your own Claude Code and older sessions");
    expect(textOf(byTestId(tree, "token-usage-outside")[0]!)).toBe("1.0M");
    const outside = byTestId(tree, "token-usage-outside-row")[0]!;
    expect(outside.type).toBe("div");
    expect(rowsOf(tree).map((row) => row.type)).toEqual(["button", "button", "button", "button"]);
  });

  it("switches the window and recounts every row from it", async () => {
    const tree = await render();
    await act(async () => clickable(radios(tree)[0]!)());
    expect(radios(tree).map((b) => b.props["aria-checked"])).toEqual([true, false, false]);
    expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("11.0M");
    expect(rowsOf(tree).map((row) => row.props["data-bot-usage-row"])).toEqual(["backend"]);

    await act(async () => clickable(radios(tree)[2]!)());
    expect(rowsOf(tree)[0]!.props["data-bot-usage-row"]).toBe("cto");
    expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("440.0M");
    expect(textOf(byTestId(tree, "token-usage-span")[0]!)).toBe("5 Sep – 4 Oct");
  });

  it("says when it was updated", async () => {
    const tree = await render();
    expect(textOf(byTestId(tree, "token-usage-updated")[0]!)).toBe("Updated 3m ago");
  });

  it("says a stale snapshot is being refreshed while it still shows the numbers", async () => {
    const tree = await render({ result: { ...READY, status: "refreshing" } });
    expect(rowsOf(tree)).toHaveLength(4);
    expect(textOf(byTestId(tree, "token-usage-updated")[0]!)).toBe("Updated 3m ago · Updating…");
    expect(tree.root.findByType("section").props["aria-busy"]).toBe(true);
  });

  it("says the count is running when the server has no snapshot yet", async () => {
    const tree = await render({ result: { status: "warming", readAt: null, windows: [] } });
    expect(rowsOf(tree)).toHaveLength(0);
    expect(textOf(tree.root.findByType("section"))).toContain("Counting tokens");
    // The ranges are there and work while it counts.
    expect(radios(tree)).toHaveLength(3);
  });

  it("shows a loading line before any answer", async () => {
    const tree = await render({ result: null });
    expect(textOf(tree.root.findByType("section"))).toContain("Loading token usage…");
    expect(rowsOf(tree)).toHaveLength(0);
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

  describe("an empty range", () => {
    const empty: PersonalBotTokenUsageResult = {
      status: "ready",
      readAt: new Date(NOW).toISOString(),
      windows: ["today", "week", "month"].map((id) =>
        windowOf(id as PersonalBotTokenUsageWindow["id"], [], totals(0)),
      ),
    };

    it("says so, with a hint on Today, and keeps the range control", async () => {
      const tree = await render({ result: empty });
      await act(async () => clickable(radios(tree)[0]!)());
      const text = textOf(tree.root.findByType("section"));
      expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("0");
      expect(text).toContain("tokens today");
      expect(text).toContain("No bot used tokens today.");
      expect(text).toContain("Pick 7 days or 30 days to see recent use.");
      expect(rowsOf(tree)).toHaveLength(0);
      expect(radios(tree)).toHaveLength(3);
    });

    it("gives no hint on a longer range", async () => {
      const tree = await render({ result: empty });
      const text = textOf(tree.root.findByType("section"));
      expect(text).toContain("No bot used tokens in this period.");
      expect(text).not.toContain("Pick 7 days");
      expect(byTestId(tree, "token-usage-rank")).toHaveLength(0);
    });
  });

  describe("the provider mix and the API price estimate", () => {
    it("shows no provider block or estimate for a window the server sent none for", async () => {
      const tree = await render();
      await act(async () => clickable(radios(tree)[0]!)());
      expect(byTestId(tree, "token-usage-providers")).toHaveLength(0);
      expect(byTestId(tree, "token-usage-provider-bar")).toHaveLength(0);
      expect(byTestId(tree, "token-usage-row-cost")).toHaveLength(0);
    });

    it("draws the provider bar and a two-column legend, most tokens first", async () => {
      const tree = await render({ result: PRICED });
      expect(byTestId(tree, "token-usage-provider-bar")).toHaveLength(1);
      const rows = providerRows(tree);
      expect(rows.map((row) => row.props["data-provider-usage-row"])).toEqual(["claude", "codex"]);
      expect(byTestId(tree, "token-usage-providers")[0]!.props.className).toContain("grid-cols-2");
      const claude = textOf(rows[0]!);
      expect(claude).toContain("Claude");
      expect(claude).toContain("126.4M");
      expect(claude).toContain("57%");
      expect(claude).toContain("$223.74");
      const codex = textOf(rows[1]!);
      expect(codex).toContain("GPT / Codex");
      expect(codex).toContain("97.0M");
      expect(codex).toContain("43%");
      expect(codex).toContain("$18.25+");
      expect(rows[0]!.props["aria-label"]).toBe(
        "Claude: 126.4M tokens, 57% of all use, estimated cost $223.74.",
      );
      for (const row of rows) expect(row.props.className).toContain("min-h-11");
    });

    it("adds the providers up to the total in the hero", async () => {
      const tree = await render({ result: PRICED });
      expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("223.4M");
      expect(textOf(byTestId(tree, "token-usage-total-cost")[0]!)).toBe("$241.99+");
    });

    it("keeps the price note closed until the estimate is tapped, then explains it", async () => {
      const tree = await render({ result: PRICED });
      expect(byTestId(tree, "token-usage-price-note")).toHaveLength(0);
      const toggle = tree.root.findAll(
        (n) => n.type === "button" && n.props["aria-controls"] === "usage-price-note",
      )[0]!;
      expect(toggle.props["aria-expanded"]).toBe(false);
      expect(toggle.props.className).toContain("min-h-11");
      await act(async () => toggle.props.onClick());
      const note = textOf(byTestId(tree, "token-usage-price-note")[0]!);
      expect(note).toContain("list API prices");
      expect(note).toContain("Not money charged");
      expect(note).toContain("subscriptions are flat");
      expect(
        tree.root.findAll(
          (n) => n.type === "button" && n.props["aria-controls"] === "usage-price-note",
        )[0]!.props["aria-expanded"],
      ).toBe(true);
    });

    it("shows the estimate on each row: priced, part priced, not priced, and Outside Bots", async () => {
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
      expect(textOf(byTestId(tree, "token-usage-outside-cost")[0]!)).toBe("$0.90");
      expect(
        rowsOf(tree).find((row) => row.props["data-bot-usage-row"] === "cto")!.props["aria-label"],
      ).toContain("$210.50");
    });
  });

  describe("the bot sheet", () => {
    const opened = (id: string, result = PRICED) => render({ result, openBotId: id });

    it("is closed until a bot is named", async () => {
      const tree = await render({ result: PRICED });
      expect(sheetOf(tree)).toHaveLength(0);
    });

    it("shows the bot's tokens, estimate, share and rank", async () => {
      const tree = await opened("cto");
      expect(sheetOf(tree)).toHaveLength(1);
      expect(textOf(byTestId(tree, "bot-usage-tokens")[0]!)).toBe("120.4M");
      expect(textOf(byTestId(tree, "bot-usage-cost")[0]!)).toBe("$210.50");
      expect(textOf(byTestId(tree, "bot-usage-share")[0]!)).toBe("54%");
      const text = sheetText(tree);
      expect(text).toContain("CTO");
      expect(text).toContain("Token use · 28 Sep – 4 Oct");
      expect(text).toContain("#1 this period");
    });

    it("lists every model in full with its tokens, estimate, share and split", async () => {
      const tree = await opened("cto");
      const models = byTestId(tree, "bot-usage-model");
      expect(models).toHaveLength(2);
      const first = textOf(models[0]!);
      expect(first).toContain("Opus 5.5");
      expect(first).toContain("Claude");
      expect(first).toContain("104.0M");
      expect(first).toContain("$200.00");
      expect(first).toContain("in 10.0M · cached 90.0M (90%) · out 4.0M");
      const second = textOf(models[1]!);
      expect(second).toContain("V4.1 Flash");
      expect(second).toContain("DeepSeek");
      expect(second).toContain("16.4M");
      expect(second).toContain("$10.50");
      // The names wrap instead of being cut.
      for (const name of byTestId(tree, "bot-usage-model-name")) {
        expect(name.props.className).toContain("[overflow-wrap:anywhere]");
        expect(name.props.className).not.toContain("truncate");
      }
      // The model rows add up to the bot's tokens.
      expect(104_000_000 + 16_400_000).toBe(120_400_000);
    });

    it("draws the provider mix bar for a bot on several providers", async () => {
      const tree = await opened("cto");
      expect(byTestId(tree, "bot-usage-mix-bar")).toHaveLength(1);
      expect(byTestId(tree, "bot-usage-single-provider")).toHaveLength(0);
      expect(textOf(byTestId(tree, "bot-usage-meta")[0]!)).toBe(
        "2 sessions · 2 models · 2 providers",
      );
    });

    it("shows how many sessions the bot had, because the data has it", async () => {
      const tree = await opened("backend");
      expect(textOf(byTestId(tree, "bot-usage-meta")[0]!)).toContain("2 sessions");
    });

    it("says how many tokens have no price when the estimate is partial", async () => {
      const tree = await opened("backend");
      expect(textOf(byTestId(tree, "bot-usage-cost")[0]!)).toBe("$18.25+");
      expect(sheetText(tree)).toContain("5.0M not priced");
    });

    it("says not priced instead of a figure when nothing has a price", async () => {
      const tree = await opened("qa");
      expect(textOf(byTestId(tree, "bot-usage-cost")[0]!)).toBe("not priced");
    });

    it("keeps a single-model bot simple: one provider line, one model, no share bar", async () => {
      const tree = await opened("cto", SINGLE);
      expect(textOf(byTestId(tree, "bot-usage-single-provider")[0]!)).toBe("All on Claude");
      expect(byTestId(tree, "bot-usage-mix-bar")).toHaveLength(0);
      expect(byTestId(tree, "bot-usage-model")).toHaveLength(1);
      expect(byTestId(tree, "bot-usage-model-bar")).toHaveLength(0);
      expect(textOf(byTestId(tree, "bot-usage-model")[0]!)).toContain("100%");
    });

    it("says so when the bot used nothing in the range, and still offers the chat", async () => {
      const tree = await opened("watcher");
      expect(textOf(byTestId(tree, "bot-usage-empty")[0]!)).toBe(
        "Watcher used no tokens in this period.",
      );
      expect(byTestId(tree, "bot-usage-tokens")).toHaveLength(0);
      expect(sheetText(tree)).toContain("Open Watcher chat");
    });

    it("shares the range with the card: switching in the sheet switches the card", async () => {
      const tree = await opened("cto");
      const groups = radios(tree);
      expect(groups).toHaveLength(6);
      // The sheet's own control is the second set of three.
      await act(async () => clickable(groups[3]!)());
      expect(radios(tree).map((b) => b.props["aria-checked"])).toEqual([
        true,
        false,
        false,
        true,
        false,
        false,
      ]);
      expect(textOf(byTestId(tree, "token-usage-total")[0]!)).toBe("11.0M");
      // CTO used nothing today.
      expect(textOf(byTestId(tree, "bot-usage-empty")[0]!)).toBe("CTO used no tokens today.");
    });

    it("closes by every route through onCloseBot", async () => {
      const onCloseBot = vi.fn();
      const tree = await render({ result: PRICED, openBotId: "cto", onCloseBot });
      const close = tree.root.findAll((n) => n.props["aria-label"] === "Close")[0]!;
      expect(close.props.className).toContain("size-11");
      tree.root.findByType(Sheet).props.onOpenChange(false);
      expect(onCloseBot).toHaveBeenCalledOnce();
    });

    it("opens the bot's chat from the sheet", async () => {
      const onOpenChat = vi.fn();
      const tree = await render({ result: PRICED, openBotId: "cto", onOpenChat });
      const open = tree.root.findAll(
        (n) => n.type === "button" && textOf(n).includes("Open CTO chat"),
      )[0]!;
      expect(open.props.className).toContain("min-h-11");
      await act(async () => clickable(open)());
      expect(onOpenChat).toHaveBeenCalledExactlyOnceWith("cto");
    });

    it("stays closed for a bot the screen does not know", async () => {
      const tree = await opened("ghost");
      expect(sheetOf(tree)).toHaveLength(0);
    });
  });

  describe("the DeepSeek balance line", () => {
    const line = (
      overrides: {
        readonly failure?: string | null;
        readonly spent?: { costUsd: number; sinceMs: number } | null;
      } = {},
    ) => ({
      balance: {
        currency: "USD",
        total: 12.34,
        granted: 2,
        toppedUp: 10.34,
        isAvailable: true,
        fetchedAt: NOW - 4 * 60_000,
        spent: overrides.spent ?? null,
      },
      failure: overrides.failure ?? null,
    });

    it("shows the balance with its split and age, from the provider's own fetch time", async () => {
      const tree = await render({ balanceLine: line() });
      const row = byTestId(tree, "token-usage-balance");
      expect(row).toHaveLength(1);
      const text = textOf(row[0]!);
      expect(text).toContain("DeepSeek balance");
      expect(text).toContain("$12.34");
      expect(text).toContain("granted $2.00 · topped up $10.34");
      // The age keeps its own line under the figure, so it is never clipped.
      expect(text).toContain("Updated 4m");
    });

    it("shows the spent figure in the same words as the usage sheet card", async () => {
      const tree = await render({
        balanceLine: line({
          spent: { costUsd: 0.9713, sinceMs: Date.parse("2026-10-10T17:25:47.680Z") },
        }),
      });
      const spent = byTestId(tree, "token-usage-balance-spent");
      expect(spent).toHaveLength(1);
      expect(textOf(spent[0]!)).toBe("Spent $0.97 since 10 Oct");
    });

    it("says nothing is recorded yet rather than inventing a figure", async () => {
      const tree = await render({ balanceLine: line() });
      const spent = byTestId(tree, "token-usage-balance-spent");
      expect(spent).toHaveLength(1);
      expect(textOf(spent[0]!)).toBe("No DeepSeek spend recorded yet.");
    });

    it("keeps the numbers and says the newest read failed", async () => {
      const tree = await render({
        balanceLine: line({ failure: "DeepSeek could not be reached for the balance." }),
      });
      const text = textOf(byTestId(tree, "token-usage-balance")[0]!);
      expect(text).toContain("$12.34");
      expect(text).toContain("Couldn't refresh · DeepSeek could not be reached for the balance.");
    });

    it("shows no line at all when there is no reading", async () => {
      const tree = await render();
      expect(byTestId(tree, "token-usage-balance")).toHaveLength(0);
    });
  });
});
