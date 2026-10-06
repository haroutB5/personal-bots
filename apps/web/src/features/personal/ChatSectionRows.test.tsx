import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBot, PersonalBotThread, PersonalGroup } from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { PinnedChatList, SnoozedChatList, sectionChatPreview } from "./ChatSectionRows";
import type { ChatSectionRow } from "./chatSections";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a
      data-to={to}
      data-params={JSON.stringify(params)}
      aria-label={(props as { "aria-label"?: string })["aria-label"]}
    >
      {children}
    </a>
  ),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement<{ "aria-label"?: string }>;
  }) => (
    <button type="button" data-menu-trigger="" aria-label={render.props["aria-label"]}>
      {children}
    </button>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" data-menu-item="" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./BotRow", () => ({ ROW_CLASS: "row", plainPreviewLine: (line: string) => line.trim() }));
vi.mock("./GroupRow", () => ({
  GroupRow: ({
    group,
    pinned,
    wakeText,
  }: {
    group: { name: string };
    pinned?: boolean;
    wakeText?: string;
  }) => (
    <a data-group-row="" data-pinned={String(pinned === true)} data-wake={wakeText}>
      {group.name}
    </a>
  ),
}));
vi.mock("./PinMark", () => ({ PinMark: () => <span data-pin-mark="" /> }));
vi.mock("./relativeTime", () => ({ formatRelativeTime: () => "2h" }));
vi.mock("./groupModel", () => ({ roundForGroup: () => null }));

const NOW = Date.UTC(2026, 9, 6, 10, 0);

const bot = { botId: "dev", name: "Dev", avatarShape: "pill", avatarColor: "#fff" } as PersonalBot;
const chatRow = (
  threadId: string,
  title: string,
  extra: { wakeMs?: number | null; newestMessage?: unknown; bot?: PersonalBot } = {},
): ChatSectionRow => ({
  kind: "chat",
  key: threadId,
  link: {
    botId: "dev",
    threadId,
    newestMessage: extra.newestMessage,
  } as unknown as PersonalBotThread,
  shell: { id: threadId, title } as unknown as EnvironmentThreadShell,
  bot: extra.bot ?? bot,
  activityMs: NOW - 7_200_000,
  wakeMs: extra.wakeMs ?? null,
});
const groupRow = (groupId: string, wakeMs: number | null = null): ChatSectionRow => ({
  kind: "group",
  key: groupId,
  group: { groupId, name: `Group ${groupId}` } as unknown as PersonalGroup,
  activityMs: NOW - 3_600_000,
  wakeMs,
});

const actions = () => ({
  onUnpin: vi.fn(),
  onSnooze: vi.fn(),
  onMarkUnread: vi.fn(),
  onWake: vi.fn(),
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

const render = (node: React.ReactElement) => {
  act(() => {
    renderer = create(node);
  });
  return renderer!.root;
};
const labelled = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
const itemsText = (root: ReactTestInstance) =>
  root.findAll((node) => node.props["data-menu-item"] === "").map((node) => node.children.join(""));

it("sectionChatPreview shows the last message's first line, and nothing for hidden or no message", () => {
  expect(
    sectionChatPreview(
      chatRow("t", "T", { newestMessage: { text: "\n  Hello there\nmore" } }) as never,
    ),
  ).toBe("Hello there");
  expect(sectionChatPreview(chatRow("t", "T") as never)).toBe("");
  expect(
    sectionChatPreview(chatRow("t", "T", { newestMessage: { text: "", hidden: true } }) as never),
  ).not.toBe("");
});

it("draws nothing when nothing is pinned or snoozed", () => {
  const props = { now: NOW, rounds: [], memberBotsOf: () => [], actions: actions() };
  const pinned = render(<PinnedChatList rows={[]} unreadThreadIds={new Set()} {...props} />);
  expect(pinned.findAll((node) => node.type === "section")).toHaveLength(0);
  const snoozed = render(<SnoozedChatList rows={[]} {...props} />);
  expect(snoozed.findAll((node) => node.type === "details")).toHaveLength(0);
});

it("a pinned chat row opens the chat, shows a pin and its unread dot, and names both", () => {
  const root = render(
    <PinnedChatList
      rows={[chatRow("t1", "Plans")]}
      now={NOW}
      unreadThreadIds={new Set(["t1"])}
      rounds={[]}
      memberBotsOf={() => []}
      actions={actions()}
    />,
  );
  const link = root.findAll((node) => node.type === "a")[0]!;
  expect(link.props["data-to"]).toBe("/bots/$botId/$threadId");
  expect(JSON.parse(link.props["data-params"])).toEqual({ botId: "dev", threadId: "t1" });
  expect(link.props["aria-label"]).toBe("Plans, Dev, pinned, unread");
  expect(root.findAll((node) => node.props["data-pin-mark"] === "")).toHaveLength(1);
  expect(JSON.stringify(renderer!.toJSON())).toContain("unread-dot");
});

it("a pinned chat's menu offers Unpin, Snooze and Mark unread; a group's has no Mark unread", () => {
  const handlers = actions();
  const chat = chatRow("t1", "Plans");
  const group = groupRow("g1");
  const root = render(
    <PinnedChatList
      rows={[chat, group]}
      now={NOW}
      unreadThreadIds={new Set()}
      rounds={[]}
      memberBotsOf={() => []}
      actions={handlers}
    />,
  );
  expect(labelled(root, "Options for Plans")).toHaveLength(1);
  expect(labelled(root, "Options for Group g1")).toHaveLength(1);
  const items = root.findAll((node) => node.props["data-menu-item"] === "");
  expect(itemsText(root)).toEqual([
    "Unpin chat",
    "Snooze…",
    "Mark unread",
    "Unpin group",
    "Snooze…",
  ]);
  act(() => items[0]!.props.onClick());
  act(() => items[1]!.props.onClick());
  act(() => items[2]!.props.onClick());
  act(() => items[3]!.props.onClick());
  expect(handlers.onUnpin).toHaveBeenNthCalledWith(1, chat);
  expect(handlers.onSnooze).toHaveBeenCalledWith(chat);
  expect(handlers.onMarkUnread).toHaveBeenCalledWith(chat);
  expect(handlers.onUnpin).toHaveBeenNthCalledWith(2, group);
  expect(root.findAll((node) => node.props["data-group-row"] === "")[0]!.props["data-pinned"]).toBe(
    "true",
  );
});

it("the Snoozed section counts its rows, shows each wake time and wakes on Wake now", () => {
  const handlers = actions();
  const chat = chatRow("t1", "Plans", { wakeMs: NOW + 8 * 3_600_000 });
  const group = groupRow("g1", NOW + 30 * 3_600_000);
  const root = render(
    <SnoozedChatList
      rows={[chat, group]}
      now={NOW}
      rounds={[]}
      memberBotsOf={() => []}
      actions={handlers}
    />,
  );
  const json = JSON.stringify(renderer!.toJSON());
  expect(json).toContain('"Snoozed (","2",")"');
  expect(root.findAll((node) => node.type === "a")[0]!.props["aria-label"]).toMatch(
    /^Plans, Dev, wakes /,
  );
  // The group row carries its wake time in place of the preview.
  expect(
    root.findAll((node) => node.props["data-group-row"] === "")[0]!.props["data-wake"],
  ).toMatch(/^Wakes /);
  const wake = labelled(root, "Wake Plans now")[0]!;
  expect(wake.children).toEqual(["Wake now"]);
  act(() => wake.props.onClick());
  act(() => labelled(root, "Wake Group g1 now")[0]!.props.onClick());
  expect(handlers.onWake).toHaveBeenNthCalledWith(1, chat);
  expect(handlers.onWake).toHaveBeenNthCalledWith(2, group);
});

it("Wake now is a 44 px button", () => {
  const root = render(
    <SnoozedChatList
      rows={[chatRow("t1", "Plans", { wakeMs: NOW + 3_600_000 })]}
      now={NOW}
      rounds={[]}
      memberBotsOf={() => []}
      actions={actions()}
    />,
  );
  expect(String(labelled(root, "Wake Plans now")[0]!.props.className)).toContain("h-11");
});
