import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { BotThreadsScreen } from "./BotThreadsScreen";
import { resetChatSeenState } from "./unreadChats";

const state = vi.hoisted(() => ({
  bulk: (() => {}) as (...args: unknown[]) => unknown,
  active: [] as unknown[],
  snoozed: [] as unknown[],
  navigate: (() => {}) as (...args: unknown[]) => unknown,
}));

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
      data-params={params === undefined ? undefined : JSON.stringify(params)}
      aria-label={(props as { "aria-label"?: string })["aria-label"]}
    >
      {children}
    </a>
  ),
  useNavigate: () => state.navigate,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" data-menu-item="" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("~/state/entities", () => ({ useThreadDetail: () => null, useThreadShells: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./botModelLabel", () => ({
  botModelShortLabel: () => null,
  botActiveModelShortLabel: () => null,
  fallbackNoteLabel: () => null,
}));
vi.mock("effect/DateTime", () => ({ toEpochMillis: (value: Date) => value.getTime() }));
vi.mock("./botThreadRows", () => ({
  botThreadRows: () => ({ active: state.active, archived: [], snoozed: state.snoozed }),
}));
vi.mock("./usePersonalGroups", () => ({
  usePersonalGroupRelayThreadIds: () => new Set<string>(),
}));
vi.mock("./botSummaries", () => ({
  isThreadLive: () => false,
  isThreadRateLimited: () => false,
  threadNeedsAttention: () => false,
}));
vi.mock("./relativeTime", () => ({ formatRelativeTime: () => "Yesterday" }));
vi.mock("./startBotChat", () => ({
  useStartBotChat: () => ({ start: async () => undefined, starting: false }),
}));
vi.mock("./PersonalOfflineBanner", () => ({ useLaptopOffline: () => false }));
vi.mock("./usePersonalAutomation", () => ({ usePersonalTasks: () => ({ tasks: null }) }));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./usePersonalBots", () => ({
  personalBotArchiveThread: {},
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: {
      bots: [
        {
          botId: "bot-a",
          name: "Ada",
          avatarShape: "pill",
          avatarColor: "#E8711A",
          modelSelection: {},
        },
      ],
      threads: [],
    },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./wrapupChat", () => ({
  useWrapupChat: () => ({ send: async () => true, sending: false }),
}));
vi.mock("./useDeleteChat", () => ({ useDeleteChat: () => async () => ({ status: "cancelled" }) }));
// The swipe layer's actions as plain buttons, so the tests can press them.
vi.mock("./SwipeToDelete", () => ({
  SwipeToDelete: ({
    children,
    secondaryActions = [],
  }: {
    children: React.ReactNode;
    secondaryActions?: ReadonlyArray<{ label: string; text: string; run: () => void }>;
  }) => (
    <div>
      {children}
      {secondaryActions.map((action) => (
        <button
          key={action.text}
          type="button"
          data-swipe={action.text}
          aria-label={action.label}
          onClick={action.run}
        />
      ))}
    </div>
  ),
}));
vi.mock("./SnoozeSheet", () => ({
  SnoozeSheet: ({
    title,
    onPick,
    onCancel,
  }: {
    title: string;
    onPick: (untilMs: number) => void;
    onCancel: () => void;
  }) => (
    <div data-snooze-sheet={title}>
      <button type="button" data-pick="" onClick={() => onPick(1_800_000_000_000)} />
      <button type="button" data-cancel="" onClick={onCancel} />
    </div>
  ),
}));
vi.mock("./useBulkChatActions", () => ({ useBulkChatActions: () => state.bulk }));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));

const row = (threadId: string, title: string, extra: Record<string, unknown> = {}) => ({
  link: { botId: "bot-a", threadId, archivedAt: null, ...extra },
  shell: { id: threadId, title, archivedAt: null, environmentId: "env-1" },
  updatedMs: Date.UTC(2026, 8, 30, 10),
});

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  });
  state.bulk = vi.fn(async () => ({
    status: "settled",
    notice: "",
    failedIds: [],
    anyFailed: false,
  }));
  state.navigate = vi.fn();
  state.active = [
    row("t-pinned", "Pinned plans", { pinnedAt: new Date(Date.UTC(2026, 9, 1)) }),
    row("t-plain", "Plain chat"),
  ];
  state.snoozed = [];
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  resetChatSeenState();
  vi.unstubAllGlobals();
});

async function renderScreen() {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
}

const byAttr = (name: string, value: string): ReactTestInstance[] =>
  renderer!.root.findAll((node) => node.type === "button" && node.props[name] === value);

const buttonByText = (label: string): ReactTestInstance[] =>
  renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      node.children.some((child) => typeof child === "string" && child === label),
  );

const press = async (node: ReactTestInstance | undefined) => {
  expect(node).toBeDefined();
  await act(async () => {
    node!.props.onClick();
  });
};

it("marks a pinned chat with a pin and offers Unpin where the plain chat offers Pin", async () => {
  await renderScreen();
  expect(
    renderer!.root.findAll(
      (node) => node.type === "svg" && node.props["data-testid"] === "pin-mark",
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(renderer!.toJSON())).toContain(", pinned");
  const labels = renderer!.root
    .findAll(
      (node) => node.props["data-swipe"] !== undefined && node.props["data-swipe"] !== "Snooze",
    )
    .map((node) => node.props["aria-label"]);
  expect(labels).toEqual(["Unpin Pinned plans", "Pin Plain chat"]);
});

it("the swipe's Pin and Unpin use the same server path, one chat at a time", async () => {
  await renderScreen();
  await press(renderer!.root.findAll((node) => node.props["aria-label"] === "Pin Plain chat")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("pin", ["t-plain"], 0, undefined);
  await press(
    renderer!.root.findAll((node) => node.props["aria-label"] === "Unpin Pinned plans")[0],
  );
  expect(state.bulk).toHaveBeenLastCalledWith("unpin", ["t-pinned"], 0, undefined);
});

it("the swipe's Snooze asks when, then snoozes that chat until then", async () => {
  await renderScreen();
  await press(
    renderer!.root.findAll((node) => node.props["aria-label"] === "Snooze Plain chat")[0],
  );
  expect(
    renderer!.root.findAll((node) => node.props["data-snooze-sheet"] === "Snooze chat"),
  ).toHaveLength(1);
  await press(byAttr("data-pick", "")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("snooze", ["t-plain"], 0, {
    snoozeUntilMs: 1_800_000_000_000,
  });
  expect(
    renderer!.root.findAll((node) => node.props["data-snooze-sheet"] !== undefined),
  ).toHaveLength(0);
});

it("a refused action says why, under the buttons", async () => {
  state.bulk = vi.fn(async () => ({
    status: "settled",
    notice: "1 chat couldn't be pinned: archived.",
    failedIds: ["t-plain"],
    anyFailed: true,
  }));
  await renderScreen();
  await press(renderer!.root.findAll((node) => node.props["aria-label"] === "Pin Plain chat")[0]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("couldn't be pinned");
});

it("lists snoozed chats in a Snoozed (n) section with their wake time and a Wake now button", async () => {
  const wake = new Date(Date.now() + 3 * 3_600_000);
  state.snoozed = [row("t-asleep", "Sleeping chat", { snoozedUntil: wake })];
  await renderScreen();
  const json = JSON.stringify(renderer!.toJSON());
  expect(json).toContain("Snoozed (");
  expect(json).toContain("Wakes ");
  await press(byAttr("aria-label", "Wake Sleeping chat now")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("wake", ["t-asleep"], 0, undefined);
  // A snoozed chat is not among the open rows.
  const openLinks = renderer!.root.findAll(
    (node) => node.type === "a" && node.props["data-to"] === "/bots/$botId/$threadId",
  );
  expect(openLinks).toHaveLength(3);
});

it("says so when every chat is snoozed", async () => {
  state.active = [];
  state.snoozed = [
    row("t-asleep", "Sleeping chat", { snoozedUntil: new Date(Date.now() + 3_600_000) }),
  ];
  await renderScreen();
  expect(JSON.stringify(renderer!.toJSON())).toContain("Every chat with Ada is snoozed.");
});

async function selectBoth() {
  await renderScreen();
  await press(buttonByText("Select chats")[0]);
  const boxes = renderer!.root.findAll((node) => node.props.role === "checkbox");
  for (const box of boxes) await press(box);
}

it("select mode gets Pin, Snooze and Mark unread beside Archive and Delete", async () => {
  await selectBoth();
  expect(buttonByText("Archive")).toHaveLength(1);
  expect(buttonByText("Delete")).toHaveLength(1);
  // One of the two is not pinned yet, so the bar offers Pin for the lot.
  await press(buttonByText("Pin")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("pin", ["t-pinned", "t-plain"], 0, undefined);
});

it("Mark unread in select mode marks the chosen chats", async () => {
  await selectBoth();
  await press(buttonByText("Mark unread")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("markUnread", ["t-pinned", "t-plain"], 0, undefined);
});

it("Snooze in select mode asks when, then snoozes the chosen chats", async () => {
  await selectBoth();
  await press(buttonByText("Snooze")[0]);
  expect(
    renderer!.root.findAll((node) => node.props["data-snooze-sheet"] === "Snooze 2 chats"),
  ).toHaveLength(1);
  await press(byAttr("data-pick", "")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("snooze", ["t-pinned", "t-plain"], 0, {
    snoozeUntilMs: 1_800_000_000_000,
  });
});

it("the bar says Unpin when every chosen chat is pinned", async () => {
  state.active = [row("t-pinned", "Pinned plans", { pinnedAt: new Date(Date.UTC(2026, 9, 1)) })];
  await renderScreen();
  await press(buttonByText("Select chats")[0]);
  await press(renderer!.root.findAll((node) => node.props.role === "checkbox")[0]);
  expect(buttonByText("Pin")).toHaveLength(0);
  await press(buttonByText("Unpin")[0]);
  expect(state.bulk).toHaveBeenLastCalledWith("unpin", ["t-pinned"], 0, undefined);
});
