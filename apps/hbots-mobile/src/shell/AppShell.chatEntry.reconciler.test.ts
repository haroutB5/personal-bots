// The real AppShell through React's reconciler. Every way into a chat must start the chat's
// snapshot request before the navigator moves, as a row press did. The screens capture the
// callbacks AppShell hands them, the test calls the one a user tap would call, and the log
// records the early request and the navigation in the order they happened.
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Handler = (...args: never[]) => unknown;

const world = vi.hoisted(() => {
  return {
    screen: { name: "Tabs", params: {} as Record<string, unknown> },
    log: [] as string[],
    props: {} as Record<string, Record<string, unknown>>,
    ready: true,
    onReady: null as (() => void) | null,
    linkListener: null as ((event: { url: string }) => void) | null,
    initialUrl: null as string | null,
    voice: null as { openChat: (botId: string, threadId: string) => void } | null,
    recovery: null as { openChat: (botId: string, threadId: string) => boolean } | null,
    capture(name: string) {
      return (props: Record<string, unknown>) => {
        world.props[name] = props;
        return null;
      };
    },
  };
});

vi.mock("react-native", () => ({
  View: (props: Record<string, unknown>) => props.children ?? null,
  StyleSheet: { create: <T>(styles: T): T => styles, hairlineWidth: 1 },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Linking: {
    getInitialURL: () => Promise.resolve(world.initialUrl),
    addEventListener: (_event: string, listener: (event: { url: string }) => void) => {
      world.linkListener = listener;
      return { remove: () => undefined };
    },
  },
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined }),
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  createNavigationContainerRef: () => ({
    isReady: () => world.ready,
    getCurrentRoute: () => undefined,
    navigate: (name: string, params: { threadId?: string }) =>
      void world.log.push(`navigate:${name}:${params.threadId ?? ""}`),
    reset: (state: { routes: Array<{ name: string; params?: { threadId?: string } }> }) =>
      void world.log.push(
        `reset:${state.routes.map((route) => `${route.name}:${route.params?.threadId ?? ""}`).join(",")}`,
      ),
  }),
  NavigationContainer: (props: { children?: ReactNode; onReady?: () => void }) => {
    world.onReady = props.onReady ?? null;
    return props.children ?? null;
  },
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
        const record = (how: string) => (name: string, params: { threadId?: string }) => {
          if (name === "Chat") world.log.push(`${how}:Chat:${params.threadId ?? ""}`);
        };
        const navigation = {
          navigate: record("navigate"),
          push: () => undefined,
          replace: record("replace"),
          goBack: () => undefined,
          setParams: () => undefined,
        };
        return shown?.props.children?.({ navigation, route: { params: world.screen.params } });
      },
    }),
  };
});
vi.mock("../personal/threadSnapshotLoader", () => ({
  snapshotSessionEnvironmentId: () => "env",
  prefetchThreadSnapshot: (threadId: string) => void world.log.push(`prefetch:${threadId}`),
}));
vi.mock("../personal/nativeCache", () => ({ hasCachedThread: () => false }));

vi.mock("../bots/BotFormScreen", () => ({ BotFormScreen: world.capture("BotFormScreen") }));
vi.mock("../bots/BotThreadsScreen", () => ({
  BotThreadsScreen: world.capture("BotThreadsScreen"),
}));
vi.mock("./BotsScreen", () => ({ BotsScreen: world.capture("BotsScreen") }));
vi.mock("./BottomBar", () => ({ BottomBar: () => null }));
vi.mock("./ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../chat/chatEnvironment", () => ({ createChatEnvironment: () => ({}) }));
vi.mock("../chat/outboxNative", () => ({
  configureNativeOutbox: () => undefined,
  useNativeOutboxFlusher: () => undefined,
}));
vi.mock("../chat/useCameraRecovery", () => ({
  useCameraRecovery: (input: { openChat: (botId: string, threadId: string) => boolean }) => {
    world.recovery = input;
  },
}));
vi.mock("../computer/ComputerScreen", () => ({
  ComputerScreen: world.capture("ComputerScreen"),
}));
vi.mock("../files/FilesScreen", () => ({ FilesScreen: () => null }));
vi.mock("../groups/GroupConversationScreen", () => ({
  GroupConversationScreen: world.capture("GroupConversationScreen"),
}));
vi.mock("../groups/NewGroupScreen", () => ({ NewGroupScreen: () => null }));
vi.mock("../notifications/clearChatNotifications", () => ({
  clearChatNotifications: () => undefined,
}));
vi.mock("../notifications/nativeNotify", () => ({ nativeNotify: {} }));
vi.mock("../screens/BotNewChatScreen", () => ({
  BotNewChatScreen: world.capture("BotNewChatScreen"),
}));
vi.mock("../screens/BotPicker", () => ({ BotPicker: world.capture("BotPicker") }));
vi.mock("../screens/ChatScreen", () => ({ ChatScreen: world.capture("ChatScreen") }));
vi.mock("../screens/ChatsListScreen", () => ({
  ChatsListScreen: world.capture("ChatsListScreen"),
}));
vi.mock("../screens/StopList", () => ({ StopList: () => null }));
vi.mock("../security/useLinkGate", () => ({
  useLinkGate: (open: (raw: string) => void) => open,
}));
vi.mock("../settings/AddProviderScreen", () => ({ AddProviderScreen: () => null }));
vi.mock("../settings/ApiKeysScreen", () => ({ ApiKeysScreen: () => null }));
vi.mock("../settings/CatalogProviderScreen", () => ({ CatalogProviderScreen: () => null }));
vi.mock("../settings/ConnectionsScreen", () => ({ ConnectionsScreen: () => null }));
vi.mock("../settings/EmailScreen", () => ({ EmailScreen: () => null }));
vi.mock("../settings/DevicesScreen", () => ({ DevicesScreen: () => null }));
vi.mock("../settings/MemoryScreen", () => ({ MemoryScreen: () => null }));
vi.mock("../settings/NotificationsScreen", () => ({ NotificationsScreen: () => null }));
vi.mock("../settings/PasswordsScreen", () => ({ PasswordsScreen: () => null }));
vi.mock("../settings/ProviderScreen", () => ({ ProviderScreen: () => null }));
vi.mock("../settings/SettingsScreen", () => ({ SettingsScreen: () => null }));
vi.mock("../settings/ThisPhoneScreen", () => ({ ThisPhoneScreen: () => null }));
vi.mock("../tasks/RoutineDetailScreen", () => ({ RoutineDetailScreen: () => null }));
vi.mock("../tasks/RoutineFormScreen", () => ({ RoutineFormScreen: () => null }));
vi.mock("../tasks/TaskDetailScreen", () => ({
  TaskDetailScreen: world.capture("TaskDetailScreen"),
}));
vi.mock("../tasks/TasksScreen", () => ({ TasksScreen: world.capture("TasksScreen") }));
vi.mock("../tasks/TaskUi", () => ({ EmptyText: () => null }));
vi.mock("../teams/NewTeamScreen", () => ({ NewTeamScreen: () => null }));
vi.mock("../teams/RemovedBotsScreen", () => ({ RemovedBotsScreen: () => null }));
vi.mock("../teams/TeamScreen", () => ({ TeamScreen: world.capture("TeamScreen") }));
vi.mock("../voice/TopReserveInsets", () => ({
  TopReserveInsets: (props: { children?: ReactNode }) => props.children ?? null,
}));
vi.mock("../voice/VoiceCallLayer", () => ({
  VoiceCallLayer: (props: {
    navigation: { openChat: (botId: string, threadId: string) => void };
  }) => {
    world.voice = props.navigation;
    return null;
  },
}));

const { AppShell } = await import("./AppShell");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NATIVE = {
  environmentId: "env",
  client: { useAtomCommand: () => () => undefined, ports: { kv: {} } },
  bots: {
    personalPushAckInApp: {},
    personalPushReportForeground: {},
    usePersonalPushInApp: () => ({ data: [] }),
  },
};

let tree: ReactTestRenderer | null = null;

function mount(screen: { name: string; params?: Record<string, unknown> }) {
  world.screen = { name: screen.name, params: screen.params ?? {} };
  world.log.length = 0;
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

function call(screen: string, prop: string, ...args: unknown[]) {
  const handler = world.props[screen]?.[prop] as Handler | undefined;
  if (handler === undefined) throw new Error(`${screen} was given no ${prop}`);
  world.log.length = 0;
  act(() => void (handler as (...rest: unknown[]) => unknown)(...args));
}

beforeEach(() => {
  world.props = {};
  world.log.length = 0;
  world.ready = true;
  world.onReady = null;
  world.linkListener = null;
  world.initialUrl = null;
  world.voice = null;
  world.recovery = null;
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe("every way into a chat starts the snapshot request before the navigator moves", () => {
  const entries: ReadonlyArray<{
    readonly entry: string;
    readonly screen: { name: string; params?: Record<string, unknown> };
    readonly host: string;
    readonly prop: string;
    readonly args: unknown[];
    readonly navigates: "navigate" | "replace";
  }> = [
    {
      entry: "a bot tile or an in-app banner on the Bots tab",
      screen: { name: "Tabs", params: { tab: "bots" } },
      host: "BotsScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "navigate",
    },
    {
      entry: "a task's chat on the Tasks tab",
      screen: { name: "Tabs", params: { tab: "tasks" } },
      host: "TasksScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "navigate",
    },
    {
      entry: "a Computer card",
      screen: { name: "Tabs", params: { tab: "computer" } },
      host: "ComputerScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "navigate",
    },
    {
      entry: "a chip or a search hit inside a chat",
      screen: { name: "Chat", params: { botId: "bot-1", threadId: "thread-0" } },
      host: "ChatScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "replace",
    },
    {
      entry: "a row on the Chats list",
      screen: { name: "Chats", params: { botId: "bot-1" } },
      host: "ChatsListScreen",
      prop: "onOpenChat",
      args: ["thread-1"],
      navigates: "replace",
    },
    {
      entry: "a goal's chat on the Chats list",
      screen: { name: "Chats", params: { botId: "bot-1" } },
      host: "ChatsListScreen",
      prop: "onOpenBotChat",
      args: ["bot-1", "thread-1"],
      navigates: "replace",
    },
    {
      entry: "a row on a bot's threads screen",
      screen: { name: "Bot", params: { botId: "bot-1" } },
      host: "BotThreadsScreen",
      prop: "onOpenChat",
      args: ["thread-1"],
      navigates: "navigate",
    },
    {
      entry: "a new chat just started for a bot",
      screen: { name: "BotNewChat", params: { botId: "bot-1" } },
      host: "BotNewChatScreen",
      prop: "onStarted",
      args: ["bot-1", "thread-1"],
      navigates: "replace",
    },
    {
      entry: "a share sent to a chat",
      screen: { name: "Share", params: { shareId: "share-1" } },
      host: "BotPicker",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "replace",
    },
    {
      entry: "a bot's chat inside a group",
      screen: { name: "Group", params: { groupId: "group-1" } },
      host: "GroupConversationScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "replace",
    },
    {
      entry: "the chat of a task",
      screen: { name: "Task", params: { taskId: "task-1" } },
      host: "TaskDetailScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "navigate",
    },
    {
      entry: "a row on the Team screen",
      screen: { name: "Team" },
      host: "TeamScreen",
      prop: "onOpenChat",
      args: ["bot-1", "thread-1"],
      navigates: "navigate",
    },
  ];

  it.each(entries)("$entry", ({ screen, host, prop, args, navigates }) => {
    mount(screen);

    call(host, prop, ...args);

    expect(world.log).toEqual(["prefetch:thread-1", `${navigates}:Chat:thread-1`]);
  });

  it("an in-call open of a chat", () => {
    mount({ name: "Tabs", params: { tab: "bots" } });
    world.log.length = 0;

    act(() => world.voice?.openChat("bot-1", "thread-1"));

    expect(world.log).toEqual(["prefetch:thread-1", "navigate:Chat:thread-1"]);
  });

  it("a chat reopened after the camera app killed the process", () => {
    mount({ name: "Tabs", params: { tab: "bots" } });
    world.log.length = 0;

    act(() => void world.recovery?.openChat("bot-1", "thread-1"));

    expect(world.log).toEqual(["prefetch:thread-1", "navigate:Chat:thread-1"]);
  });

  it("a notification tapped while the app is open", () => {
    mount({ name: "Tabs", params: { tab: "bots" } });
    world.log.length = 0;

    act(() => world.linkListener?.({ url: "hbots://chat/bot-1/thread-1" }));

    expect(world.log).toEqual(["prefetch:thread-1", "reset:Tabs:,Chat:thread-1"]);
  });

  it("a notification that starts the app waits for the navigator, but its request does not", async () => {
    world.ready = false;
    world.initialUrl = "hbots://chat/bot-1/thread-1";

    mount({ name: "Tabs", params: { tab: "bots" } });
    await act(async () => void (await Promise.resolve()));
    expect(world.log).toEqual(["prefetch:thread-1"]);

    world.ready = true;
    act(() => world.onReady?.());

    expect(world.log).toEqual(["prefetch:thread-1", "reset:Tabs:,Chat:thread-1"]);
  });

  it("a link to a screen that is not a chat starts no request", () => {
    mount({ name: "Tabs", params: { tab: "bots" } });
    world.log.length = 0;

    act(() => world.linkListener?.({ url: "hbots://settings" }));

    expect(world.log).toEqual(["reset:Tabs:,Settings:"]);
  });
});
