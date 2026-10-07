import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatSettingsContent } from "./ChatSettingsSheet";
import {
  chatSettingsHeader,
  chatSettingsRows,
  type ChatSettingsRowContext,
  type ChatSettingsTarget,
} from "./chatSettingsModel";
import { snoozePresets } from "./chatState";

// Base UI's sheet needs a DOM; the content inside it is the part with behaviour.
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children, ...props }: { children: React.ReactNode }) => (
    <h2 {...props}>{children}</h2>
  ),
}));

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const presets = snoozePresets(new Date(NOW));

const target = (overrides: Partial<ChatSettingsTarget> = {}): ChatSettingsTarget => ({
  threadId: "t-other",
  title: "Tennis",
  kind: "chat",
  isOpenChat: false,
  pinned: false,
  archived: false,
  snoozedUntilMs: null,
  unread: false,
  state: "idle",
  words: null,
  working: false,
  activityMs: NOW - 2 * 3_600_000,
  preview: null,
  ...overrides,
});
const context = (overrides: Partial<ChatSettingsRowContext> = {}): ChatSettingsRowContext => ({
  turnsUnavailable: false,
  wrapupSending: false,
  threadLoading: false,
  nowMs: NOW,
  ...overrides,
});

let renderer: ReactTestRenderer | undefined;
const callbacks = {
  onSelect: vi.fn(),
  onSnoozePick: vi.fn(),
  onCancel: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { requestAnimationFrame: (run: () => void) => run() });
  callbacks.onSelect = vi.fn();
  callbacks.onSnoozePick = vi.fn();
  callbacks.onCancel = vi.fn();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function render(
  t: ChatSettingsTarget,
  c: ChatSettingsRowContext = context(),
  preview: string | null = null,
) {
  const header = { ...chatSettingsHeader(t, NOW), preview };
  await act(async () => {
    renderer = create(
      <ChatSettingsContent
        header={header}
        groups={chatSettingsRows(t, c)}
        chatName={t.title}
        presets={presets}
        {...callbacks}
      />,
    );
  });
  return renderer!;
}

const rows = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll(
    (node) => node.type === "button" && node.props["data-chat-settings-row"] !== undefined,
  );
const rowIds = (tree: ReactTestRenderer) =>
  rows(tree).map((node) => node.props["data-chat-settings-row"]);
const rowByName = (tree: ReactTestRenderer, id: string) =>
  rows(tree).find((node) => node.props["data-chat-settings-row"] === id)!;
const textOf = (node: ReactTestInstance): string =>
  node
    .findAll((child) => typeof child.type === "string")
    .flatMap((child) => child.children.filter((entry) => typeof entry === "string"))
    .join(" ");
const buttons = (tree: ReactTestRenderer) => tree.root.findAllByType("button");
const byTestId = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((node) => node.props["data-testid"] === id);

describe("the sheet's content", () => {
  it("shows the chat's title, meta and last message above the rows", async () => {
    const tree = await render(target(), context(), "Serve was better today");
    expect(textOf(byTestId(tree, "chat-settings-title")[0]!)).toContain("Tennis");
    expect(textOf(byTestId(tree, "chat-settings-meta")[0]!)).toContain("Last message 2h ago");
    expect(textOf(byTestId(tree, "chat-settings-preview")[0]!)).toContain("Serve was better today");
  });

  it("leaves the last message out when there is none (or the bot hides previews)", async () => {
    const tree = await render(target());
    expect(
      byTestId(tree, "chat-settings-preview").filter((node) => typeof node.type === "string"),
    ).toHaveLength(0);
  });

  it("lists the rows in order, then Cancel", async () => {
    const tree = await render(target());
    expect(rowIds(tree)).toEqual([
      "pin",
      "snooze",
      "markUnread",
      "rename",
      "wrapup",
      "archive",
      "delete",
    ]);
    const all = buttons(tree);
    expect(textOf(all.at(-1)!)).toBe("Cancel");
    expect(textOf(rowByName(tree, "wrapup"))).toContain("Opens it");
  });

  it("hands a chosen row up, and Cancel closes", async () => {
    const tree = await render(target());
    await act(async () => rowByName(tree, "pin").props.onClick());
    expect(callbacks.onSelect).toHaveBeenCalledWith("pin");
    await act(async () => rowByName(tree, "delete").props.onClick());
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("delete");
    await act(async () => buttons(tree).at(-1)!.props.onClick());
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it("a disabled Wrapup is marked aria-disabled, says why, and does nothing when tapped", async () => {
    const tree = await render(target({ working: true }));
    const wrapup = rowByName(tree, "wrapup");
    expect(wrapup.props["aria-disabled"]).toBe(true);
    expect(textOf(wrapup)).toContain("After this reply");
    await act(async () => wrapup.props.onClick());
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    // Not a native `disabled`: the row stays focusable so a screen reader reads the reason.
    expect(wrapup.props.disabled).toBeUndefined();
    expect(rowByName(tree, "pin").props["aria-disabled"]).toBeUndefined();
  });

  it("shows only Rename, Unarchive and Delete for an archived chat", async () => {
    const tree = await render(target({ archived: true, kind: "archived", isOpenChat: true }));
    expect(rowIds(tree)).toEqual(["rename", "unarchive", "delete"]);
  });

  it("shows Wake now with its time for a snoozed chat", async () => {
    const wake = new Date(2026, 9, 8, 9, 0, 0).getTime();
    const tree = await render(target({ snoozedUntilMs: wake }));
    expect(rowIds(tree)).toEqual([
      "pin",
      "wake",
      "markUnread",
      "rename",
      "wrapup",
      "archive",
      "delete",
    ]);
    expect(textOf(rowByName(tree, "wake"))).toContain("Tomorrow 09:00");
  });

  it("leaves Mark unread out of an unread chat", async () => {
    const tree = await render(target({ unread: true }));
    expect(rowIds(tree)).not.toContain("markUnread");
  });

  it("draws Delete in the error colour", async () => {
    const tree = await render(target());
    expect(
      rowByName(tree, "delete").findAll((node) =>
        String(node.props.className).includes("personal-error"),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("snooze in place", () => {
  it("swaps the rows for the choices, with Back and the chat's name, and does not leave the sheet", async () => {
    const tree = await render(target());
    await act(async () => rowByName(tree, "snooze").props.onClick());
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(rowIds(tree)).toEqual([]);
    const names = buttons(tree).map((node) => node.props["aria-label"] ?? textOf(node));
    expect(names[0]).toBe("Back to chat settings");
    expect(names.slice(1, 1 + presets.length)).toEqual(
      presets.map((preset) => `${preset.label}, ${preset.detail}`),
    );
    expect(names.at(-1)).toBe("Cancel");
    expect(textOf(tree.root.findByProps({ "data-chat-settings-step": "snooze" }))).toContain(
      "Tennis",
    );
    expect(textOf(tree.root.findByProps({ "data-chat-settings-step": "snooze" }))).toContain(
      "Snooze until",
    );
  });

  it("a choice hands back its time and nothing else", async () => {
    const tree = await render(target());
    await act(async () => rowByName(tree, "snooze").props.onClick());
    const tomorrow = buttons(tree).find((node) => node.props["data-snooze-preset"] === "tomorrow")!;
    await act(async () => tomorrow.props.onClick());
    expect(callbacks.onSnoozePick).toHaveBeenCalledTimes(1);
    expect(callbacks.onSnoozePick).toHaveBeenCalledWith(
      presets.find((preset) => preset.key === "tomorrow")!.untilMs,
    );
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("Back returns to the rows, and Cancel closes the whole sheet", async () => {
    const tree = await render(target());
    await act(async () => rowByName(tree, "snooze").props.onClick());
    await act(async () => buttons(tree)[0]!.props.onClick());
    expect(rowIds(tree)).toContain("snooze");
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    await act(async () => rowByName(tree, "snooze").props.onClick());
    await act(async () => buttons(tree).at(-1)!.props.onClick());
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });
});
