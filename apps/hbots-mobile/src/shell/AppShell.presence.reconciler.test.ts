// The real AppShell through React's reconciler, with the navigator, the screens and react-native
// replaced by stand-ins. It shows whether the app reports "on screen" and takes in-app
// notifications whichever screen the navigator shows: the server sends a phone push to a phone
// that reported nothing, so a screen that does not report is a screen where Harout gets pushed.
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const world = vi.hoisted(() => {
  type Listener = () => void;
  const feedListeners = new Set<Listener>();
  const appStateListeners = new Set<(state: string) => void>();
  return {
    screen: { name: "Tabs", params: {} as Record<string, unknown> },
    appState: "active",
    feed: null as ReadonlyArray<Record<string, unknown>> | null,
    reports: [] as boolean[],
    acks: [] as string[],
    feedListeners,
    appStateListeners,
    Null: () => null,
  };
});

vi.mock("react-native", () => ({
  View: (props: Record<string, unknown>) => props.children ?? null,
  StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 1 },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Linking: {
    getInitialURL: () => Promise.resolve(null),
    addEventListener: () => ({ remove: () => undefined }),
  },
  AppState: {
    get currentState() {
      return world.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      world.appStateListeners.add(listener);
      return { remove: () => world.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  createNavigationContainerRef: () => ({
    isReady: () => false,
    getCurrentRoute: () => undefined,
    navigate: () => undefined,
    reset: () => undefined,
  }),
  NavigationContainer: (props: { children?: ReactNode }) => props.children ?? null,
  useIsFocused: () => true,
}));
vi.mock("@react-navigation/native-stack", async () => {
  const { Children } = await import("react");
  type ScreenElement = { props: { name: string; children?: (arg: unknown) => ReactNode } };
  return {
    createNativeStackNavigator: () => ({
      Screen: () => null,
      Navigator: (props: { children?: ReactNode }) => {
        const screens = Children.toArray(props.children) as unknown as ScreenElement[];
        const shown = screens.find((element) => element.props.name === world.screen.name);
        const navigation = {
          navigate: () => undefined,
          push: () => undefined,
          replace: () => undefined,
          goBack: () => undefined,
          setParams: () => undefined,
        };
        return shown?.props.children?.({ navigation, route: { params: world.screen.params } });
      },
    }),
  };
});

vi.mock("../personal/chatPress", () => ({
  pressChat: (_threadId: string, open: () => void) => open(),
  onChatPress: () => undefined,
}));
vi.mock("../bots/BotFormScreen", () => ({ BotFormScreen: world.Null }));
vi.mock("../bots/BotThreadsScreen", () => ({ BotThreadsScreen: world.Null }));
vi.mock("./BotsScreen", () => ({ BotsScreen: world.Null }));
vi.mock("./BottomBar", () => ({ BottomBar: world.Null }));
vi.mock("./ScreenHeader", () => ({ ScreenHeader: world.Null }));
vi.mock("../chat/chatEnvironment", () => ({ createChatEnvironment: () => ({}) }));
vi.mock("../chat/outboxNative", () => ({
  configureNativeOutbox: () => undefined,
  useNativeOutboxFlusher: () => undefined,
}));
vi.mock("../chat/useCameraRecovery", () => ({ useCameraRecovery: () => undefined }));
vi.mock("../computer/ComputerScreen", async () => {
  const { createElement: h } = await import("react");
  return { ComputerScreen: () => h("ComputerScreen") };
});
vi.mock("../files/FilesScreen", async () => {
  const { createElement: h } = await import("react");
  return { FilesScreen: () => h("FilesScreen") };
});
vi.mock("../groups/GroupConversationScreen", () => ({ GroupConversationScreen: world.Null }));
vi.mock("../groups/NewGroupScreen", () => ({ NewGroupScreen: world.Null }));
vi.mock("../notifications/clearChatNotifications", () => ({
  clearChatNotifications: () => undefined,
}));
vi.mock("../notifications/nativeNotify", () => ({ nativeNotify: {} }));
vi.mock("../screens/BotNewChatScreen", () => ({ BotNewChatScreen: world.Null }));
vi.mock("../screens/BotPicker", () => ({ BotPicker: world.Null }));
vi.mock("../screens/ChatScreen", async () => {
  const { createElement: h } = await import("react");
  return { ChatScreen: () => h("ChatScreen") };
});
vi.mock("../screens/ChatsListScreen", () => ({ ChatsListScreen: world.Null }));
vi.mock("../screens/StopList", () => ({ StopList: world.Null }));
vi.mock("../security/useLinkGate", () => ({ useLinkGate: () => () => undefined }));
vi.mock("../settings/AddProviderScreen", () => ({ AddProviderScreen: world.Null }));
vi.mock("../settings/ApiKeysScreen", () => ({ ApiKeysScreen: world.Null }));
vi.mock("../settings/CatalogProviderScreen", () => ({ CatalogProviderScreen: world.Null }));
vi.mock("../settings/ConnectionsScreen", () => ({ ConnectionsScreen: world.Null }));
vi.mock("../settings/DevicesScreen", () => ({ DevicesScreen: world.Null }));
vi.mock("../settings/MemoryScreen", () => ({ MemoryScreen: world.Null }));
vi.mock("../settings/NotificationsScreen", () => ({ NotificationsScreen: world.Null }));
vi.mock("../settings/PasswordsScreen", () => ({ PasswordsScreen: world.Null }));
vi.mock("../settings/ProviderScreen", () => ({ ProviderScreen: world.Null }));
vi.mock("../settings/SettingsScreen", () => ({ SettingsScreen: world.Null }));
vi.mock("../settings/ThisPhoneScreen", () => ({ ThisPhoneScreen: world.Null }));
vi.mock("../tasks/RoutineDetailScreen", () => ({ RoutineDetailScreen: world.Null }));
vi.mock("../tasks/RoutineFormScreen", () => ({ RoutineFormScreen: world.Null }));
vi.mock("../tasks/TaskDetailScreen", () => ({ TaskDetailScreen: world.Null }));
vi.mock("../tasks/TasksScreen", async () => {
  const { createElement: h } = await import("react");
  return { TasksScreen: () => h("TasksScreen") };
});
vi.mock("../tasks/TaskUi", () => ({ EmptyText: world.Null }));
vi.mock("../teams/NewTeamScreen", () => ({ NewTeamScreen: world.Null }));
vi.mock("../teams/RemovedBotsScreen", () => ({ RemovedBotsScreen: world.Null }));
vi.mock("../teams/TeamScreen", () => ({ TeamScreen: world.Null }));
vi.mock("../voice/TopReserveInsets", () => ({
  TopReserveInsets: (props: { children?: ReactNode }) => props.children ?? null,
}));
vi.mock("../voice/VoiceCallLayer", () => ({ VoiceCallLayer: world.Null }));

const { AppShell } = await import("./AppShell");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACK = { command: "ack" };
const REPORT = { command: "report" };
const recorders = new Map<unknown, (arg: { input: Record<string, unknown> }) => void>([
  [ACK, ({ input }) => void world.acks.push(input.id as string)],
  [REPORT, ({ input }) => void world.reports.push(input.foreground as boolean)],
]);

const NATIVE = {
  environmentId: "env",
  client: {
    useAtomCommand: (command: unknown) => recorders.get(command),
    ports: { kv: {} },
  },
  bots: {
    personalPushAckInApp: ACK,
    personalPushReportForeground: REPORT,
    usePersonalPushInApp: () => ({
      data: useFeed(),
    }),
  },
};

import { useSyncExternalStore } from "react";
function useFeed() {
  return useSyncExternalStore(
    (listener) => {
      world.feedListeners.add(listener);
      return () => world.feedListeners.delete(listener);
    },
    () => world.feed,
  );
}

function notification(id: string, url = `/bots/b/${id}`): Record<string, unknown> {
  return { id, url, title: "Bot", body: "Reply", createdAt: "2026-11-16T10:00:00.000Z" };
}

function arrive(feed: ReadonlyArray<Record<string, unknown>>) {
  act(() => {
    world.feed = feed;
    for (const listener of world.feedListeners) listener();
  });
}

function setAppState(state: string) {
  act(() => {
    world.appState = state;
    for (const listener of world.appStateListeners) listener(state);
  });
}

let tree: ReactTestRenderer | null = null;

function mount(screen: { name: string; params?: Record<string, unknown> }) {
  world.screen = { name: screen.name, params: screen.params ?? {} };
  act(() => {
    tree = create(
      createElement(AppShell as never, {
        native: NATIVE,
        installedVersion: "1.0.0",
        update: null,
        latest: null,
        onCheckNow: () => undefined,
        onInstall: () => undefined,
        onOpenPermission: () => undefined,
        onSignOut: () => undefined,
      }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  world.appState = "active";
  world.feed = [];
  world.reports.length = 0;
  world.acks.length = 0;
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  world.feedListeners.clear();
  world.appStateListeners.clear();
  vi.useRealTimers();
});

describe.each([
  ["Tasks tab", { name: "Tabs", params: { tab: "tasks" } }, "TasksScreen"],
  ["Computer tab", { name: "Tabs", params: { tab: "computer" } }, "ComputerScreen"],
  ["Files tab", { name: "Tabs", params: { tab: "files" } }, "FilesScreen"],
  [
    "a chat opened from another tab",
    { name: "Chat", params: { botId: "b", threadId: "t" } },
    "ChatScreen",
  ],
])("the app on screen showing %s", (_label, screen, host) => {
  it("reports foreground, keeps reporting every 10 s, and acknowledges a new notification", () => {
    mount(screen);
    expect(tree?.root.findAll((node) => (node.type as unknown) === host)).toHaveLength(1);
    expect(world.reports).toEqual([true]);

    act(() => void vi.advanceTimersByTime(10_000));
    expect(world.reports).toEqual([true, true]);

    arrive([notification("n1")]);
    expect(world.acks).toEqual(["n1"]);
  });
});

describe("the app that is not on screen", () => {
  it("reports it, acknowledges nothing and stops the heartbeat once it goes to the background", () => {
    mount({ name: "Tabs", params: { tab: "tasks" } });
    expect(world.reports).toEqual([true]);

    setAppState("background");
    expect(world.reports).toEqual([true, false]);

    arrive([notification("n1")]);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(world.acks).toEqual([]);
    expect(world.reports).toEqual([true, false]);
  });

  it("acknowledges nothing when it starts in the background", () => {
    world.appState = "background";
    world.feed = [notification("n1")];
    mount({ name: "Tabs", params: { tab: "files" } });

    act(() => void vi.advanceTimersByTime(60_000));
    expect(world.acks).toEqual([]);
    expect(world.reports).toEqual([false]);
  });

  it("acknowledges what arrived meanwhile once it returns to the screen", () => {
    world.appState = "background";
    mount({ name: "Tabs", params: { tab: "tasks" } });
    arrive([notification("n1")]);
    expect(world.acks).toEqual([]);

    setAppState("active");
    expect(world.reports).toEqual([false, true]);
    expect(world.acks).toEqual([]);

    arrive([notification("n1"), notification("n2")]);
    expect(world.acks).toEqual(["n2"]);
  });
});
