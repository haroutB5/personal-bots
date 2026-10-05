import type { PersonalMemoryEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MemoryScreen } from "./MemoryScreen";

type Filter = {
  readonly kind?: string;
  readonly replaced?: boolean;
  readonly query?: string;
  readonly limit?: number;
};

const state = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
  lists: {} as Record<string, { entries: ReadonlyArray<unknown>; total: number } | null>,
}));

vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [] } }),
}));
vi.mock("./useMinuteNow", () => ({ useMinuteNow: () => Date.UTC(2026, 9, 5) }));
vi.mock("./useBulkDelete", () => ({
  MEMORY_NOUN: { one: "memory", many: "memories" },
  useBulkDeleteMemories: () => async () => ({ status: "cancelled" }),
}));
vi.mock("./RulesUsageCard", () => ({
  RulesUsageCard: () => <div data-section="rules-usage" />,
}));
vi.mock("./MemoryTidyPanels", () => ({
  MemoryWaitingSection: () => <div data-section="waiting" />,
  MemoryTidySection: () => <div data-section="tidy" />,
  ArchivedMemorySection: (props: {
    total: number;
    searching: boolean;
    entries: ReadonlyArray<unknown> | null;
    onShowMore: () => void;
  }) => (
    <button
      type="button"
      data-section="archived"
      data-total={props.total}
      data-searching={props.searching}
      data-count={props.entries?.length ?? -1}
      onClick={props.onShowMore}
    />
  ),
  ShowMoreButton: (props: { shown: number; total: number; onClick: () => void }) => (
    <button
      type="button"
      data-show-more={`${props.shown}/${props.total}`}
      onClick={props.onClick}
    />
  ),
}));
vi.mock("./usePersonalAutomation", () => ({
  personalMemoryDelete: {},
  personalMemoryFeedback: {},
  usePersonalTasks: () => ({ tasks: new Map() }),
  usePersonalTasksByIds: () => null,
  usePersonalMemoryList: (_env: string, filter: Filter) => {
    state.calls.push(filter);
    const key = filter.replaced === true ? "replaced" : (filter.kind ?? "all");
    const list = state.lists[key];
    return { data: list ?? null, error: null, isPending: false, isSuccess: list !== null };
  },
}));

const NOW = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");

function entry(memoryId: string, kind: PersonalMemoryEntry["kind"], content: string) {
  return {
    memoryId,
    scope: "shared",
    scopeId: null,
    kind,
    content,
    source: "user",
    sensitivity: "normal",
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

let renderer: ReactTestRenderer | undefined;

async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(<MemoryScreen />);
  });
  return renderer!;
}

const text = (root: ReactTestRenderer) => JSON.stringify(root.toJSON()).replace(/<[^>]*>/g, "");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.calls = [];
  state.lists = {
    preference: {
      entries: [entry("r1", "preference", "Keep replies short")],
      total: 1,
    },
    note: {
      entries: [entry("n1", "note", "The garden is south facing")],
      total: 234,
    },
    task_summary: {
      entries: [entry("s1", "task_summary", "**Pure Aero check:**\n- **eBay UK:** nothing")],
      total: 733,
    },
    replaced: { entries: [], total: 0 },
  };
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Memory screen (1.60.45)", () => {
  it("asks for every rule at once and a first page of notes and task summaries", async () => {
    await render();
    const byKind = (kind: string) =>
      state.calls.find((call) => (call as Filter).kind === kind) as Filter;
    expect(byKind("preference").limit).toBeGreaterThanOrEqual(1_000);
    expect(byKind("note").limit).toBe(100);
    expect(byKind("task_summary").limit).toBe(30);
    expect(state.calls.some((call) => (call as Filter).replaced === true)).toBe(true);
  });

  it("lists Rules first, then Notes, then Task summaries, with the totals from the server", async () => {
    const root = await render();
    const headings = root.root.findAllByType("h2").map((node) => node.children.join(""));
    expect(headings).toEqual(["Rules · 1", "Notes · 234", "Task summaries · 733"]);
  });

  it("puts the waiting and tidy-up sections above the search and list, and Archived last", async () => {
    const root = await render();
    const order = root.root
      .findAll(
        (node) =>
          typeof node.props["data-section"] === "string" ||
          node.type === "input" ||
          node.type === "h2",
      )
      .map((node) =>
        node.type === "h2"
          ? node.children.join("")
          : node.type === "input"
            ? "search"
            : (node.props["data-section"] as string),
      );
    expect(order).toEqual([
      "rules-usage",
      "waiting",
      "tidy",
      "search",
      "Rules · 1",
      "Notes · 234",
      "Task summaries · 733",
      "archived",
    ]);
  });

  it("shows Show more under a list that has more, and a bigger page after a tap", async () => {
    const root = await render();
    const more = root.root.findAll((node) => typeof node.props["data-show-more"] === "string");
    expect(more.map((node) => node.props["data-show-more"])).toEqual(["1/234", "1/733"]);
    state.calls = [];
    await act(async () => more[0]!.props.onClick());
    const notes = state.calls.filter((call) => (call as Filter).kind === "note") as Filter[];
    expect(notes.at(-1)?.limit).toBe(200);
    const summaries = state.calls.filter(
      (call) => (call as Filter).kind === "task_summary",
    ) as Filter[];
    expect(summaries.at(-1)?.limit).toBe(30);
  });

  it("the search goes to the server for every list, after a short pause", async () => {
    const root = await render();
    const input = root.root.findByType("input");
    state.calls = [];
    await act(async () => input.props.onChange({ target: { value: "  tea  " } }));
    // Typing alone does not ask yet.
    expect(state.calls.every((call) => (call as Filter).query === "")).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const kinds = ["preference", "note", "task_summary"];
    for (const kind of kinds) {
      const last = state.calls.filter((call) => (call as Filter).kind === kind).at(-1) as Filter;
      expect(last.query).toBe("tea");
    }
    const archived = state.calls.filter((call) => (call as Filter).replaced === true).at(-1);
    expect((archived as Filter).query).toBe("tea");
  });

  it("task summaries show as plain text, without ** marks", async () => {
    const root = await render();
    const paragraphs = root.root.findAllByType("p").map((node) => node.children.join(""));
    expect(paragraphs).toContain("Pure Aero check:\n• eBay UK: nothing");
    expect(paragraphs.some((paragraph) => paragraph.includes("**"))).toBe(false);
  });

  it("says nothing is saved only when there is nothing, and 'no match' for an empty search", async () => {
    state.lists = {
      preference: { entries: [], total: 0 },
      note: { entries: [], total: 0 },
      task_summary: { entries: [], total: 0 },
      replaced: { entries: [], total: 0 },
    };
    const root = await render();
    expect(text(root)).toContain("Nothing saved yet");
    const input = root.root.findByType("input");
    await act(async () => input.props.onChange({ target: { value: "zzz" } }));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(text(root)).toContain("No memory matches that search.");
  });

  it("hands the Archived section its total, so its title counts all of them", async () => {
    state.lists.replaced = { entries: [entry("o1", "note", "old")], total: 61 };
    const root = await render();
    const archived = root.root.findByProps({ "data-section": "archived" });
    expect(archived.props["data-total"]).toBe(61);
    expect(archived.props["data-count"]).toBe(1);
  });
});
