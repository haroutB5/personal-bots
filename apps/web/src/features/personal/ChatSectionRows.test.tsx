import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBot, PersonalBotThread, PersonalGroup } from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { SnoozedChatList } from "./ChatSectionRows";
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
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./BotRow", () => ({ ROW_CLASS: "row" }));
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
vi.mock("./groupModel", () => ({ roundForGroup: () => null }));

const NOW = Date.UTC(2026, 9, 6, 10, 0);

const bot = { botId: "dev", name: "Dev", avatarShape: "pill", avatarColor: "#fff" } as PersonalBot;
const chatRow = (
  threadId: string,
  title: string,
  extra: { wakeMs?: number | null } = {},
): ChatSectionRow => ({
  kind: "chat",
  key: threadId,
  link: { botId: "dev", threadId } as unknown as PersonalBotThread,
  shell: { id: threadId, title } as unknown as EnvironmentThreadShell,
  bot,
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

const actions = () => ({ onWake: vi.fn() });

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

it("draws nothing when nothing is snoozed", () => {
  const root = render(
    <SnoozedChatList rows={[]} now={NOW} rounds={[]} memberBotsOf={() => []} actions={actions()} />,
  );
  expect(root.findAll((node) => node.type === "details")).toHaveLength(0);
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
  const link = root.findAll((node) => node.type === "a")[0]!;
  expect(link.props["data-to"]).toBe("/bots/$botId/$threadId");
  expect(JSON.parse(link.props["data-params"])).toEqual({ botId: "dev", threadId: "t1" });
  expect(link.props["aria-label"]).toMatch(/^Plans, Dev, wakes /);
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

it("a snoozed row has no pin mark and no Pinned section around it", () => {
  const root = render(
    <SnoozedChatList
      rows={[chatRow("t1", "Plans", { wakeMs: NOW + 3_600_000 })]}
      now={NOW}
      rounds={[]}
      memberBotsOf={() => []}
      actions={actions()}
    />,
  );
  const json = JSON.stringify(renderer!.toJSON());
  expect(json).not.toContain("Pinned");
  expect(root.findAll((node) => node.props["data-pin-mark"] === "")).toHaveLength(0);
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
