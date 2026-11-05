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
import { IconChevronRight, IconSettings } from "@tabler/icons-react-native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BackHandler, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AndroidRelease } from "../compat";
import { createChatEnvironment } from "../chat/chatEnvironment";
import { configureNativeOutbox, useNativeOutboxFlusher } from "../chat/outboxNative";
import { back, parseDeepLink, type Route, type TabName } from "../nav/routes";
import type { NativePersonal } from "../personal/nativePersonalClient";
import type { UpdateSnapshot } from "../updater";
import { UpdateSettings } from "../UpdateSettings";
import { BotsScreen } from "./BotsScreen";
import { BottomBar } from "./BottomBar";
import { ScreenHeader } from "./ScreenHeader";
import { tokens } from "./tokens";
import { ChatScreen } from "../screens/ChatScreen";
import { ChatsListScreen } from "../screens/ChatsListScreen";

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
  Task: { readonly taskId: string };
  Routine: { readonly routineId: string };
  Team: undefined;
  Settings: undefined;
  ThisPhone: undefined;
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

function SettingsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Settings">) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title="Settings" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.settingsBody}>
        <View style={styles.group}>
          <Pressable
            onPress={() => navigation.navigate("ThisPhone")}
            accessibilityRole="button"
            accessibilityLabel="This phone"
            style={styles.settingsRow}
          >
            <View style={styles.settingsIcon}>
              <IconSettings size={20} color={tokens.text} strokeWidth={2} />
            </View>
            <Text style={styles.settingsTitle}>This phone</Text>
            <IconChevronRight size={20} color={tokens.textTertiary} strokeWidth={2} />
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function ThisPhoneScreen({
  navigation,
  props,
}: NativeStackScreenProps<RootStackParamList, "ThisPhone"> & { readonly props: AppShellProps }) {
  return (
    <UpdateSettings
      title="This phone"
      installedVersion={props.installedVersion}
      snapshot={props.update}
      latest={props.latest}
      onBack={() => navigation.goBack()}
      onCheckNow={props.onCheckNow}
      onInstall={props.onInstall}
      onOpenPermission={props.onOpenPermission}
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
    case "task":
      return { name: "Task", params: { taskId: route.taskId } };
    case "routine":
      return { name: "Routine", params: { routineId: route.routineId } };
    case "settings":
      return { name: "Settings" };
    case "thisPhone":
      return { name: "ThisPhone" };
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
          animation: "slide_from_right",
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
          {({ navigation }) => (
            <HeaderScreen title="Bot" onBack={() => navigation.goBack()}>
              <Placeholder title="Bot" body="Bot settings will show here." />
            </HeaderScreen>
          )}
        </Stack.Screen>
        <Stack.Screen name="Task">
          {({ navigation }) => (
            <HeaderScreen title="Task" onBack={() => navigation.goBack()}>
              <Placeholder title="Task" body="Task detail will show here." />
            </HeaderScreen>
          )}
        </Stack.Screen>
        <Stack.Screen name="Routine">
          {({ navigation }) => (
            <HeaderScreen title="Routine" onBack={() => navigation.goBack()}>
              <Placeholder title="Routine" body="Routine detail will show here." />
            </HeaderScreen>
          )}
        </Stack.Screen>
        <Stack.Screen name="Team">
          {({ navigation }) => (
            <HeaderScreen title="Team" onBack={() => navigation.goBack()}>
              <Placeholder title="Team" body="Your team will show here." />
            </HeaderScreen>
          )}
        </Stack.Screen>
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="ThisPhone">
          {(screenProps) => <ThisPhoneScreen {...screenProps} props={props} />}
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

function TabsWithBots({
  native,
  chat,
  installedVersion,
  ...screenProps
}: TabsProps & {
  readonly native: NativePersonal;
  readonly chat: ReturnType<typeof createChatEnvironment>;
  readonly installedVersion: string;
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
            onOpenChat={(botId, threadId) => navigation.navigate("Chat", { botId, threadId })}
            onOpenChats={(botId) => navigation.navigate("Chats", { botId })}
            onOpenTeam={() => navigation.navigate("Team")}
            onOpenSettings={() => navigation.navigate("Settings")}
          />
        ) : tab === "tasks" ? (
          <Placeholder title="Tasks" body="Your tasks will show here." />
        ) : tab === "computer" ? (
          <Placeholder title="Computer" body="The live computer view will show here." />
        ) : (
          <Placeholder title="Files" body="Shared files will show here." />
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
  settingsTitle: { color: tokens.text, fontSize: 16, fontWeight: "500", flex: 1 },
});
