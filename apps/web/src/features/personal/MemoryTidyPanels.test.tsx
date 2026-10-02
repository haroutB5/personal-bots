import type { PersonalMemoryTidyChange } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MemoryTidySection, MemoryWaitingSection, TidyChangeItem } from "./MemoryTidyPanels";
import { UNLISTED_MEMORY_TEXT } from "./memoryPresentation";

const tidyLog = vi.hoisted(() => ({ data: null as unknown, error: null as string | null }));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("./usePersonalAutomation", () => ({
  personalMemoryRestore: {},
  personalMemoryTidyDecide: {},
  personalMemoryTidyRun: {},
  personalMemoryTidySetMode: {},
  usePersonalMemoryTidyLog: () => tidyLog,
}));

const change = (overrides: Partial<Record<string, unknown>>): PersonalMemoryTidyChange =>
  ({
    changeId: 1,
    status: "applied",
    action: "supersede",
    scope: "shared",
    scopeId: null,
    memoryIds: ["m-old"],
    resultMemoryId: "m-new",
    content: null,
    changeHash: "h",
    reason: "",
    ...overrides,
  }) as unknown as PersonalMemoryTidyChange;

const texts = new Map([
  ["m-old", "Lives in Leeds"],
  ["m-new", "Lives in York now"],
  ["m-long", "Likes tea. Works on the dev team."],
]);

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  tidyLog.data = null;
});

const textOf = (item: PersonalMemoryTidyChange): string => {
  act(() => {
    renderer = create(<TidyChangeItem change={item} texts={texts} botName={() => undefined} />);
  });
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer!.toJSON());
  return parts.join("|");
};

describe("TidyChangeItem", () => {
  it("shows what a supersede archives and the newer entry it keeps", () => {
    const shown = textOf(change({ content: "Lives in York" }));
    expect(shown).toContain("Archives|Lives in Leeds");
    expect(shown).toContain("Keeps (newer)|Lives in York");
    expect(shown).not.toContain("Lives in York now");
  });

  it("falls back to the listed text, then a plain line, for the kept entry", () => {
    expect(textOf(change({}))).toContain("Keeps (newer)|Lives in York now");
    act(() => renderer?.unmount());
    expect(textOf(change({ resultMemoryId: "m-gone" }))).toContain(
      `Keeps (newer)|${UNLISTED_MEMORY_TEXT}`,
    );
  });

  it("shows a retirement as just the archived list", () => {
    const shown = textOf(change({ resultMemoryId: null }));
    expect(shown).toContain("Archives|Lives in Leeds");
    expect(shown).not.toContain("Keeps (newer)");
  });

  it("shows a split's entry and each part with its kind and reach", () => {
    const shown = textOf(
      change({
        action: "split",
        status: "pending",
        memoryIds: ["m-long"],
        resultMemoryId: null,
        parts: [
          { content: "Likes tea.", kind: "preference", scope: "shared", scopeId: null },
          { content: "Works on the dev team.", kind: "note", scope: "team", scopeId: "dev" },
        ],
      }),
    );
    expect(shown).toContain("Split|");
    expect(shown).toContain("Archives|Likes tea. Works on the dev team.");
    expect(shown).toContain("Split into (2)");
    expect(shown).toContain("Likes tea.|Preference · All bots");
    expect(shown).toContain("Works on the dev team.|Note · Dev team");
  });
});

describe("TidyChangeItem: what an approval is bound to", () => {
  it("tags each archived entry with the kind and reach it is bound to, and the kept one as text only", () => {
    const text = textOf(
      change({
        status: "pending",
        bound: [
          { memoryId: "m-old", kind: "preference", scope: "team", scopeId: "dev", textOnly: false },
          { memoryId: "m-new", kind: "preference", scope: "shared", scopeId: null, textOnly: true },
        ],
      }),
    );
    expect(text).toContain("Bound to: Preference · Dev team");
    expect(text).toContain("Bound to its text");
  });

  it("shows no bound tags for an older change without snapshots", () => {
    expect(textOf(change({ status: "pending" }))).not.toContain("Bound to");
  });
});

describe("TidyChangeItem: the binding label is never clipped", () => {
  it("renders Bound to outside the three-line clamped entry text", () => {
    act(() => {
      renderer = create(
        <TidyChangeItem
          change={change({
            status: "pending",
            bound: [
              { memoryId: "m-old", kind: "note", scope: "shared", scopeId: null, textOnly: false },
              { memoryId: "m-new", kind: "note", scope: "shared", scopeId: null, textOnly: true },
            ],
          })}
          texts={texts}
          botName={() => undefined}
        />,
      );
    });
    const textIn = (node: { children: ReadonlyArray<unknown> }): string =>
      node.children
        .map((child) =>
          typeof child === "string" ? child : textIn(child as { children: ReadonlyArray<unknown> }),
        )
        .join("");
    const clamped = renderer!.root.findAll(
      (node) =>
        typeof node.props.className === "string" && node.props.className.includes("line-clamp"),
    );
    expect(clamped.length).toBeGreaterThan(0);
    // The entry text stays clamped; the label is not inside any clamped element.
    expect(clamped.some((node) => textIn(node).includes("Lives in Leeds"))).toBe(true);
    expect(clamped.some((node) => textIn(node).includes("Bound to"))).toBe(false);
    const label = renderer!.root.findAll(
      (node) => node.type === "p" && textIn(node) === "Bound to: Note · All bots",
    );
    expect(label).toHaveLength(1);
  });
});

/** A live-like Waiting list: 82 bot and proposal-file changes in two groups. */
const liveLikeLog = (pending: number) => ({
  mode: "preview",
  runs: [
    {
      runId: "bot-proposals-2026-10-02",
      startedAt: "2026-10-02T08:00:00.000Z",
      finishedAt: "2026-10-02T08:00:00.000Z",
      status: "done",
      dryRun: true,
      model: "proposals: from bots, 2026-10-02",
      merged: 0,
      superseded: 0,
      leftAlone: 0,
      error: null,
      changes: Array.from({ length: Math.min(pending, 30) }, (_, index) =>
        change({
          changeId: index + 1,
          status: "pending",
          action: "save",
          memoryIds: [],
          resultMemoryId: null,
          content: "Rule " + String(index + 1),
          toKind: "preference",
          toScope: "team",
          toScopeId: "dev",
          proposedBy: "bot:cto",
        }),
      ),
    },
    {
      runId: "file-proposals-2oct-c-dev-team",
      startedAt: "2026-10-02T03:00:00.000Z",
      finishedAt: "2026-10-02T03:00:00.000Z",
      status: "done",
      dryRun: true,
      model: "proposals: proposals-2oct-c-dev-team.json",
      merged: 0,
      superseded: 0,
      leftAlone: 0,
      error: null,
      changes: Array.from({ length: Math.max(pending - 30, 0) }, (_, index) =>
        change({
          changeId: 100 + index,
          status: "pending",
          action: "reclassify",
          memoryIds: ["m-old"],
          resultMemoryId: null,
          toScope: "team",
          toScopeId: "dev",
        }),
      ),
    },
  ],
});

const renderWaiting = () => {
  act(() => {
    renderer = create(
      <MemoryWaitingSection environmentId={null} texts={texts} botName={() => undefined} />,
    );
  });
  return renderer!;
};

/** Every string rendered inside a node. */
const textIn = (node: ReactTestRenderer["root"]): string =>
  node.children.map((child) => (typeof child === "string" ? child : textIn(child))).join("");

const toggleOf = (root: ReactTestRenderer["root"]) =>
  root.find((node) => node.type === "button" && node.props["aria-expanded"] !== undefined);

describe("1.60.22: Waiting for your OK is its own section, open when something waits", () => {
  it("shows the count, open, with Select all per group, when 82 changes wait", () => {
    tidyLog.data = liveLikeLog(82);
    const root = renderWaiting().root;
    const toggle = toggleOf(root);
    expect(textIn(toggle)).toContain("Waiting for your OK (82)");
    expect(toggle.props["aria-expanded"]).toBe(true);
    const panel = root.find(
      (node) => node.type === "div" && node.props.id === toggle.props["aria-controls"],
    );
    expect(panel.props.hidden).toBe(false);
    const selectAll = root.findAll(
      (node) =>
        node.type === "button" &&
        node.props.role === "checkbox" &&
        textIn(node).includes("Select all in this group"),
    );
    expect(selectAll).toHaveLength(2);
    expect(
      root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === "Select this change",
      ),
    ).toHaveLength(82);
  });

  it("folds on a tap and stays folded", () => {
    tidyLog.data = liveLikeLog(3);
    const root = renderWaiting().root;
    act(() => toggleOf(root).props.onClick());
    expect(toggleOf(root).props["aria-expanded"]).toBe(false);
  });

  it("is a closed one-line section when nothing waits", () => {
    tidyLog.data = liveLikeLog(0);
    const toggle = toggleOf(renderWaiting().root);
    expect(textIn(toggle)).toContain("Waiting for your OK (0)");
    expect(textIn(toggle)).toContain("Nothing is waiting.");
    expect(toggle.props["aria-expanded"]).toBe(false);
  });

  it("renders nothing while the log loads", () => {
    expect(renderWaiting().toJSON()).toBeNull();
  });

  it("the Nightly tidy-up section no longer holds the Waiting list", () => {
    tidyLog.data = liveLikeLog(82);
    act(() => {
      renderer = create(
        <MemoryTidySection environmentId={null} texts={texts} botName={() => undefined} />,
      );
    });
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).not.toContain("Waiting for your OK (");
    expect(json).not.toContain("Select all in this group");
  });
});
