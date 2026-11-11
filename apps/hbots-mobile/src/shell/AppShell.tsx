import {
  createNavigationContainerRef,
  NavigationContainer,
  type Theme,
  useIsFocused,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BackHandler, Linking, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AndroidRelease } from "../compat";
import { chatComputerTarget } from "../chat/chatComputer";
import { createChatEnvironment } from "../chat/chatEnvironment";
import { configureNativeOutbox, useNativeOutboxFlusher } from "../chat/outboxNative";
import { back, parseDeepLink, type Route, type TabName } from "../nav/routes";
import { BotFormScreen } from "../bots/BotFormScreen";
import { BotThreadsScreen } from "../bots/BotThreadsScreen";
import { BotNewChatScreen } from "../screens/BotNewChatScreen";
import { BotPicker } from "../screens/BotPicker";
import { GroupConversationScreen } from "../groups/GroupConversationScreen";
import { NewGroupScreen } from "../groups/NewGroupScreen";
import { NewTeamScreen } from "../teams/NewTeamScreen";
import { RemovedBotsScreen } from "../teams/RemovedBotsScreen";
import { TeamScreen } from "../teams/TeamScreen";
import type { NativePersonal } from "../personal/nativePersonalClient";
import type { UpdateSnapshot } from "../updater";
import { BotsScreen } from "./BotsScreen";
import { BottomBar } from "./BottomBar";
import { ScreenHeader } from "./ScreenHeader";
import { tokens } from "./tokens";
import { FilesScreen } from "../files/FilesScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { ChatsListScreen } from "../screens/ChatsListScreen";
import { ComputerScreen } from "../computer/ComputerScreen";
import { DevicesScreen } from "../settings/DevicesScreen";
import { AddProviderScreen } from "../settings/AddProviderScreen";
import { CatalogProviderScreen } from "../settings/CatalogProviderScreen";
import { ProviderScreen } from "../settings/ProviderScreen";
import { SettingsScreen } from "../settings/SettingsScreen";
import { ThisPhoneScreen } from "../settings/ThisPhoneScreen";
import { NotificationsScreen } from "../settings/NotificationsScreen";
import { MemoryScreen } from "../settings/MemoryScreen";
import { PasswordsScreen } from "../settings/PasswordsScreen";
import { ApiKeysScreen } from "../settings/ApiKeysScreen";
import { ConnectionsScreen } from "../settings/ConnectionsScreen";
import { RoutineDetailScreen } from "../tasks/RoutineDetailScreen";
import { RoutineFormScreen } from "../tasks/RoutineFormScreen";
import { TaskDetailScreen } from "../tasks/TaskDetailScreen";
import { TasksScreen } from "../tasks/TasksScreen";
import { EmptyText } from "../tasks/TaskUi";

export interface AppShellProps {
  readonly native: NativePersonal;
  readonly installedVersion: string;
  readonly update: UpdateSnapshot | null;
  readonly latest: AndroidRelease | null;
  readonly onCheckNow: () => void;
  readonly onInstall: () => void;
  readonly onOpenPermission: () => void;
  readonly onSignOut: () => void;
}

export type RootStackParamList = {
  Tabs: { readonly tab?: TabName } | undefined;
  Chat: { readonly botId: string; readonly threadId: string; readonly requestId?: string };
  Chats: { readonly botId: string };
  Bot: { readonly botId: string };
  BotNew: undefined;
  BotNewChat: { readonly botId: string };
  Share: { readonly shareId: string };
  BotEdit: { readonly botId: string };
  Group: { readonly groupId: string };
  GroupNew: undefined;
  Task: { readonly taskId: string };
  Routine: { readonly routineId: string };
  RoutineForm: { readonly routineId?: string };
  Team: undefined;
  TeamNew: undefined;
  TeamRemoved: undefined;
  Settings: undefined;
  SettingsNotifications: undefined;
  Provider: { readonly instanceId: string };
  ProviderAdd: undefined;
  ProviderCatalog: { readonly catalogId: string };
  ThisPhone: undefined;
  SettingsDevices: undefined;
  Memory: undefined;
  Passwords: undefined;
  ApiKeys: undefined;
  Connections: undefined;
  Stop: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

const navigationTheme: Theme = {
  dark: true,
  colors: {
    primary: tokens.primary,
    background: tokens.bg,
    card: tokens.bg,
    text: tokens.text,
    border: tokens.border,
    notification: tokens.needs,
  },
  fonts: {
    regular: { fontFamily: "System", fontWeight: "400" },
    medium: { fontFamily: "System", fontWeight: "500" },
    bold: { fontFamily: "System", fontWeight: "600" },
    heavy: { fontFamily: "System", fontWeight: "700" },
  },
};

type TabsProps = NativeStackScreenProps<RootStackParamList, "Tabs">;

function Placeholder({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderTitle}>{title}</Text>
      <Text style={styles.placeholderBody}>{body}</Text>
    </View>
  );
}

function HeaderScreen({
  title,
  onBack,
  children,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={title} onBack={onBack} />
      <View style={styles.tabContent}>{children}</View>
    </View>
  );
}

function ThisPhoneRoute({
  navigation,
  props,
}: NativeStackScreenProps<RootStackParamList, "ThisPhone"> & { readonly props: AppShellProps }) {
  return (
    <ThisPhoneScreen
      native={props.native}
      installedVersion={props.installedVersion}
      snapshot={props.update}
      latest={props.latest}
      onBack={() => navigation.goBack()}
      onCheckNow={props.onCheckNow}
      onInstall={props.onInstall}
      onOpenPermission={props.onOpenPermission}
      onOpenDevices={() => navigation.navigate("SettingsDevices")}
      onSignOut={props.onSignOut}
    />
  );
}

function toNavigationRoute(route: Route): { name: keyof RootStackParamList; params?: object } {
  switch (route.kind) {
    case "tab":
      return { name: "Tabs", params: { tab: route.tab } };
    case "team":
      return { name: "Team" };
    case "teamNew":
      return { name: "TeamNew" };
    case "teamRemoved":
      return { name: "TeamRemoved" };
    case "chat":
      return {
        name: "Chat",
        params:
          route.requestId === undefined
            ? { botId: route.botId, threadId: route.threadId }
            : { botId: route.botId, threadId: route.threadId, requestId: route.requestId },
      };
    case "bot":
      return { name: "Bot", params: { botId: route.botId } };
    case "botNew":
      return { name: "BotNew" };
    case "botNewChat":
      return { name: "BotNewChat", params: { botId: route.botId } };
    case "share":
      return { name: "Share", params: { shareId: route.shareId } };
    case "botEdit":
      return { name: "BotEdit", params: { botId: route.botId } };
    case "group":
      return { name: "Group", params: { groupId: route.groupId } };
    case "groupNew":
      return { name: "GroupNew" };
    case "task":
      return { name: "Task", params: { taskId: route.taskId } };
    case "routine":
      return { name: "Routine", params: { routineId: route.routineId } };
    case "settings":
      return { name: "Settings" };
    case "settingsNotifications":
      return { name: "SettingsNotifications" };
    case "settingsProvidersAdd":
      return { name: "ProviderAdd" };
    case "settingsProvider":
      return { name: "Provider", params: { instanceId: route.instanceId } };
    case "settingsProviderCatalog":
      return { name: "ProviderCatalog", params: { catalogId: route.catalogId } };
    case "thisPhone":
      return { name: "ThisPhone" };
    case "memory":
      return { name: "Memory" };
    case "passwords":
      return { name: "Passwords" };
    case "apiKeys":
      return { name: "ApiKeys" };
    case "connections":
      return { name: "Connections" };
    case "stop":
      return { name: "Stop" };
  }
}

function Shell({ props }: { readonly props: AppShellProps }) {
  const pendingLink = useRef<string | null>(null);
  const chat = useMemo(() => createChatEnvironment(props.native), [props.native]);

  useEffect(() => {
    configureNativeOutbox(props.native);
  }, [props.native]);
  useNativeOutboxFlusher(props.native, chat);

  const openLink = useCallback((raw: string) => {
    const state = parseDeepLink(raw);
    if (state === null) return;
    if (!navigationRef.isReady()) {
      pendingLink.current = raw;
      return;
    }
    const routes = state.stack.map(toNavigationRoute);
    navigationRef.reset({ index: routes.length - 1, routes });
  }, []);

  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url !== null) openLink(url);
    });
    const subscription = Linking.addEventListener("url", (event) => openLink(event.url));
    return () => subscription.remove();
  }, [openLink]);

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navigationTheme}
      onReady={() => {
        const pending = pendingLink.current;
        if (pending !== null) {
          pendingLink.current = null;
          openLink(pending);
        }
      }}
    >
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: "fade",
          contentStyle: { backgroundColor: tokens.bg },
        }}
      >
        <Stack.Screen name="Tabs">
          {(screenProps) => (
            <TabsWithBots
              {...screenProps}
              native={props.native}
              chat={chat}
              installedVersion={props.installedVersion}
              update={props.update}
              onOpenInstallPermission={props.onOpenPermission}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Chat">
          {({ navigation, route }) => (
            <ChatScreen
              native={props.native}
              chat={chat}
              botId={route.params.botId}
              threadId={route.params.threadId}
              onBack={() => navigation.goBack()}
              onOpenChat={(botId, threadId) => navigation.replace("Chat", { botId, threadId })}
              onOpenChats={(botId) => navigation.navigate("Chats", { botId })}
              onOpenBot={(botId) => navigation.navigate("Bot", { botId })}
              onOpenRoutine={(routineId) => navigation.navigate("Routine", { routineId })}
              onOpenComputer={() => navigation.navigate("Tabs", chatComputerTarget())}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Chats">
          {({ navigation, route }) => (
            <ChatsListScreen
              native={props.native}
              chat={chat}
              botId={route.params.botId}
              onBack={() => navigation.goBack()}
              onOpenChat={(threadId) =>
                navigation.replace("Chat", { botId: route.params.botId, threadId })
              }
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Bot">
          {({ navigation, route }) => (
            <BotThreadsScreen
              native={props.native}
              chat={chat}
              botId={route.params.botId}
              onBack={() => navigation.goBack()}
              onOpenChat={(threadId) =>
                navigation.navigate("Chat", { botId: route.params.botId, threadId })
              }
              onEditBot={(botId) => navigation.navigate("BotEdit", { botId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="BotNew">
          {({ navigation }) => (
            <BotFormScreen
              native={props.native}
              target={{ kind: "new" }}
              onBack={() => navigation.goBack()}
              onLeave={() => navigation.goBack()}
              onDeleted={() => navigation.popToTop()}
              onOpenTeam={() => navigation.navigate("Team")}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="BotNewChat">
          {({ navigation, route }) => (
            <BotNewChatScreen
              native={props.native}
              botId={route.params.botId}
              onBack={() => navigation.goBack()}
              onStarted={(botId, threadId) => navigation.replace("Chat", { botId, threadId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Share">
          {({ navigation, route }) => (
            <BotPicker
              native={props.native}
              shareId={route.params.shareId}
              onClose={() => navigation.goBack()}
              onOpenChat={(botId, threadId) => navigation.replace("Chat", { botId, threadId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="BotEdit">
          {({ navigation, route }) => (
            <BotFormScreen
              native={props.native}
              target={{ kind: "edit", botId: route.params.botId }}
              onBack={() => navigation.goBack()}
              onLeave={() => navigation.goBack()}
              onDeleted={() => navigation.popToTop()}
              onOpenTeam={() => navigation.navigate("Team")}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Group">
          {({ navigation, route }) => (
            <GroupConversationScreen
              native={props.native}
              chat={chat}
              groupId={route.params.groupId}
              onBack={() => navigation.goBack()}
              onOpenChat={(botId, threadId) => navigation.replace("Chat", { botId, threadId })}
              onEditBot={(botId) => navigation.navigate("BotEdit", { botId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="GroupNew">
          {({ navigation }) => (
            <NewGroupScreen
              native={props.native}
              onBack={() => navigation.goBack()}
              onCreated={(groupId) => navigation.replace("Group", { groupId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Task">
          {({ navigation, route }) => (
            <TaskDetailScreen
              native={props.native}
              taskId={route.params.taskId}
              onBack={() => navigation.goBack()}
              onOpenTask={(taskId) => navigation.push("Task", { taskId })}
              onOpenChat={(botId, threadId) => navigation.navigate("Chat", { botId, threadId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Routine">
          {({ navigation, route }) => (
            <RoutineDetailScreen
              native={props.native}
              routineId={route.params.routineId}
              onBack={() => navigation.goBack()}
              onOpenTask={(taskId) => navigation.push("Task", { taskId })}
              onEdit={() => navigation.push("RoutineForm", { routineId: route.params.routineId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="RoutineForm">
          {({ navigation, route }) => (
            <RoutineFormRoute
              native={props.native}
              routineId={route.params?.routineId}
              onBack={() => navigation.goBack()}
              onSaved={(routineId) => navigation.replace("Routine", { routineId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Team">
          {({ navigation }) => (
            <TeamScreen
              native={props.native}
              onBack={() => navigation.goBack()}
              onNewTeam={() => navigation.navigate("TeamNew")}
              onNewBot={() => navigation.navigate("BotNew")}
              onOpenBot={(botId) => navigation.navigate("Bot", { botId })}
              onOpenTask={(taskId) => navigation.navigate("Task", { taskId })}
              onOpenChat={(botId, threadId) => navigation.navigate("Chat", { botId, threadId })}
              onOpenChats={(botId) => navigation.navigate("Chats", { botId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="TeamNew">
          {({ navigation }) => (
            <NewTeamScreen
              native={props.native}
              onBack={() => navigation.goBack()}
              onCreated={() => navigation.replace("Team")}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="TeamRemoved">
          {({ navigation }) => (
            <RemovedBotsScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Settings">
          {({ navigation }) => (
            <SettingsScreen
              native={props.native}
              installedVersion={props.installedVersion}
              onBack={() => navigation.goBack()}
              onOpenThisPhone={() => navigation.navigate("ThisPhone")}
              onOpenTeam={() => navigation.navigate("Team")}
              onOpenNewBot={() => navigation.navigate("BotNew")}
              onOpenRemovedBots={() => navigation.navigate("TeamRemoved")}
              onOpenProvider={(instanceId) => navigation.navigate("Provider", { instanceId })}
              onOpenAddProvider={() => navigation.navigate("ProviderAdd")}
              onOpenNotifications={() => navigation.navigate("SettingsNotifications")}
              onOpenMemory={() => navigation.navigate("Memory")}
              onOpenPasswords={() => navigation.navigate("Passwords")}
              onOpenApiKeys={() => navigation.navigate("ApiKeys")}
              onOpenConnections={() => navigation.navigate("Connections")}
              onOpenRoutines={() => undefined}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="SettingsNotifications">
          {({ navigation }) => (
            <NotificationsScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Provider">
          {({ navigation, route }) => (
            <ProviderScreen
              native={props.native}
              instanceId={route.params.instanceId}
              onBack={() => navigation.goBack()}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="ProviderAdd">
          {({ navigation }) => (
            <AddProviderScreen
              native={props.native}
              onBack={() => navigation.goBack()}
              onOpenProvider={(instanceId) => navigation.navigate("Provider", { instanceId })}
              onOpenCatalog={(catalogId) => navigation.navigate("ProviderCatalog", { catalogId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="ProviderCatalog">
          {({ navigation, route }) => (
            <CatalogProviderScreen
              native={props.native}
              catalogId={route.params.catalogId}
              onBack={() => navigation.goBack()}
              onInstalled={(instanceId) => navigation.replace("Provider", { instanceId })}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="Memory">
          {({ navigation }) => (
            <MemoryScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Passwords">
          {({ navigation }) => (
            <PasswordsScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="ApiKeys">
          {({ navigation }) => (
            <ApiKeysScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Connections">
          {({ navigation }) => (
            <ConnectionsScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="ThisPhone">
          {(screenProps) => <ThisPhoneRoute {...screenProps} props={props} />}
        </Stack.Screen>
        <Stack.Screen name="SettingsDevices">
          {({ navigation }) => (
            <DevicesScreen native={props.native} onBack={() => navigation.goBack()} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Stop">
          {({ navigation }) => (
            <HeaderScreen title="Stop" onBack={() => navigation.goBack()}>
              <Placeholder title="Bots working" body="Nothing is working right now." />
            </HeaderScreen>
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function RoutineFormRoute({
  native,
  routineId,
  onBack,
  onSaved,
}: {
  readonly native: NativePersonal;
  readonly routineId: string | undefined;
  readonly onBack: () => void;
  readonly onSaved: (routineId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const routines = native.automation.usePersonalRoutines(native.environmentId);
  if (routineId !== undefined && routines.data === null) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ScreenHeader title="Routine" onBack={onBack} />
        <EmptyText>Loading…</EmptyText>
      </View>
    );
  }
  const routine =
    routineId === undefined
      ? null
      : (routines.data?.routines.find((entry) => entry.routineId === routineId) ?? null);
  if (routineId !== undefined && routine === null) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ScreenHeader title="Routine" onBack={onBack} />
        <EmptyText>This routine was not found.</EmptyText>
      </View>
    );
  }
  return <RoutineFormScreen native={native} routine={routine} onBack={onBack} onSaved={onSaved} />;
}

function TabsWithBots({
  native,
  chat,
  installedVersion,
  update,
  onOpenInstallPermission,
  ...screenProps
}: TabsProps & {
  readonly native: NativePersonal;
  readonly chat: ReturnType<typeof createChatEnvironment>;
  readonly installedVersion: string;
  readonly update: UpdateSnapshot | null;
  readonly onOpenInstallPermission: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tab = screenProps.route.params?.tab ?? "bots";
  const { navigation } = screenProps;
  const focused = useIsFocused();

  useEffect(() => {
    if (!focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (tab === "bots") return false;
      navigation.setParams({ tab: "bots" });
      return true;
    });
    return () => subscription.remove();
  }, [focused, navigation, tab]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.tabContent}>
        {tab === "bots" ? (
          <BotsScreen
            native={native}
            chat={chat}
            installedVersion={installedVersion}
            update={update}
            onOpenInstallPermission={onOpenInstallPermission}
            onOpenChat={(botId, threadId) => navigation.navigate("Chat", { botId, threadId })}
            onOpenChats={(botId) => navigation.navigate("Chats", { botId })}
            onOpenGroup={(groupId) => navigation.navigate("Group", { groupId })}
            onOpenTeam={() => navigation.navigate("Team")}
            onOpenSettings={() => navigation.navigate("Settings")}
          />
        ) : tab === "tasks" ? (
          <TasksScreen
            native={native}
            onOpenTask={(taskId) => navigation.push("Task", { taskId })}
            onOpenRoutine={(routineId) => navigation.push("Routine", { routineId })}
            onNewRoutine={() => navigation.navigate("RoutineForm", {})}
          />
        ) : tab === "computer" ? (
          <ComputerScreen
            native={native}
            onOpenChat={(botId, threadId) => navigation.navigate("Chat", { botId, threadId })}
          />
        ) : (
          <FilesScreen native={native} />
        )}
      </View>
      <BottomBar
        active={tab}
        bottomInset={insets.bottom}
        onSelect={(next) => navigation.setParams({ tab: next })}
      />
    </View>
  );
}

export function AppShell(props: AppShellProps) {
  return <Shell props={props} />;
}

// The pure stack helpers stay exported for the tests and for later screens.
export { back };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  tabContent: { flex: 1 },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  placeholderTitle: { color: tokens.text, fontSize: 18, fontWeight: "600" },
  placeholderBody: { color: tokens.textSecondary, fontSize: 13, textAlign: "center" },
  settingsBody: { padding: 16 },
  group: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    overflow: "hidden",
  },
  settingsRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
  },
  settingsIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  settingsTitle: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  settingsText: { flex: 1, gap: 2 },
  settingsDetail: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  settingsBadge: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 7,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  settingsBadgeText: { color: tokens.text, fontSize: 12, fontWeight: "600" },
});
