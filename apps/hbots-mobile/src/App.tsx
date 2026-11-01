import type { PersonalBot, PersonalBotThread } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import {
  backoffMs,
  describePairFailure,
  openOnline,
  refreshBots,
  REFRESH_INTERVAL_MS,
} from "./connection";
import { classifyFailure } from "./failure";
import { pair } from "./pairing";
import { describePairingLinkError, parsePairingLink } from "./pairingLink";
import { renewSession } from "./renew";
import { startRenewScheduler, type ForegroundSource } from "./renewScheduler";
import type { PersonalRpc } from "./rpc";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session";
import { describeSignOut, revokeRemoteSession } from "./signOut";

type Screen =
  | { readonly kind: "booting" }
  | { readonly kind: "unpaired"; readonly error: string | null; readonly notice: string | null }
  | { readonly kind: "connecting"; readonly step: string }
  | {
      readonly kind: "online";
      readonly session: StoredSession;
      readonly serverVersion: string | null;
      readonly bots: ReadonlyArray<PersonalBot>;
      readonly threads: ReadonlyArray<PersonalBotThread>;
    }
  | { readonly kind: "laptopOffline"; readonly session: StoredSession; readonly attempt: number }
  | { readonly kind: "signedOut" };

const appForeground: ForegroundSource = {
  subscribe: (onForeground) => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        onForeground();
      }
    });
    return () => subscription.remove();
  },
};

const COLORS = {
  bg: "#0f0f0e",
  card: "#191918",
  border: "#2a2a27",
  text: "#f2f0ec",
  muted: "#928d85",
  accent: "#e3c477",
  danger: "#f08a7a",
};

const ROW_HEIGHT = 76;

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function modelLine(bot: PersonalBot): string {
  const route = `${String(bot.modelSelection.instanceId)}/${bot.modelSelection.model}`;
  return bot.title.length > 0 ? `${bot.title} · ${route}` : route;
}

function chatCount(threads: ReadonlyArray<PersonalBotThread>, botId: string): number {
  return threads.filter((thread) => thread.botId === botId && thread.archivedAt === null).length;
}

function BotRow({ bot, chats }: { readonly bot: PersonalBot; readonly chats: number }) {
  return (
    <View style={styles.row}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials(bot.name)}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.botName} numberOfLines={1}>
          {bot.name}
          {bot.lead === true ? "  ·  lead" : ""}
        </Text>
        <Text style={styles.botMeta} numberOfLines={1}>
          {modelLine(bot)}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.chatCount}>{chats}</Text>
        <Text style={styles.chatLabel}>chats</Text>
      </View>
    </View>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "booting" });
  const [link, setLink] = useState("");
  const rpcRef = useRef<PersonalRpc | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const stopRenewRef = useRef<(() => void) | null>(null);

  const disposeRpc = useCallback(() => {
    const rpc = rpcRef.current;
    rpcRef.current = null;
    if (rpc !== null) {
      void rpc.dispose();
    }
  }, []);

  const stopRenew = useCallback(() => {
    stopRenewRef.current?.();
    stopRenewRef.current = null;
  }, []);

  const endSession = useCallback(
    async (next: Screen) => {
      stopRenew();
      disposeRpc();
      sessionRef.current = null;
      await clearSession();
      setScreen(next);
    },
    [disposeRpc, stopRenew],
  );

  const handleFailure = useCallback(
    async (cause: unknown, session: StoredSession, attempt: number) => {
      disposeRpc();
      if (classifyFailure(cause).kind === "authDead") {
        await endSession({ kind: "signedOut" });
        return;
      }
      setScreen({ kind: "laptopOffline", session, attempt });
    },
    [disposeRpc, endSession],
  );

  const goOnline = useCallback(
    async (session: StoredSession, attempt: number) => {
      disposeRpc();
      setScreen({ kind: "connecting", step: "Connecting" });
      try {
        const online = await openOnline(session);
        rpcRef.current = online.rpc;
        setScreen({
          kind: "online",
          session,
          serverVersion: online.serverVersion,
          bots: online.bots,
          threads: online.threads,
        });
      } catch (cause) {
        await handleFailure(cause, session, attempt);
      }
    },
    [disposeRpc, handleFailure],
  );

  const startRenew = useCallback(() => {
    stopRenew();
    stopRenewRef.current = startRenewScheduler({
      foreground: appForeground,
      run: async () => {
        const current = sessionRef.current;
        if (current === null) {
          return;
        }
        const renewed = await renewSession(current);
        sessionRef.current = renewed;
        await saveSession(renewed);
      },
      onError: (cause) => {
        if (classifyFailure(cause).kind === "authDead") {
          void endSession({ kind: "signedOut" });
        }
      },
    });
  }, [endSession, stopRenew]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const session = await loadSession();
      if (!live) {
        return;
      }
      if (session === null) {
        setScreen({ kind: "unpaired", error: null, notice: null });
        return;
      }
      sessionRef.current = session;
      startRenew();
      await goOnline(session, 0);
    })();
    return () => {
      live = false;
      stopRenew();
      disposeRpc();
    };
  }, [disposeRpc, goOnline, startRenew, stopRenew]);

  useEffect(() => {
    if (screen.kind !== "laptopOffline") {
      return;
    }
    const { session, attempt } = screen;
    const timer = setTimeout(() => void goOnline(session, attempt + 1), backoffMs(attempt));
    return () => clearTimeout(timer);
  }, [goOnline, screen]);

  useEffect(() => {
    if (screen.kind !== "online") {
      return;
    }
    const { session, serverVersion } = screen;
    const timer = setInterval(() => {
      const rpc = rpcRef.current;
      if (rpc === null) {
        return;
      }
      refreshBots(rpc).then(
        (snapshot) => setScreen({ kind: "online", session, serverVersion, ...snapshot }),
        (cause: unknown) => void handleFailure(cause, session, 0),
      );
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [handleFailure, screen]);

  const submitLink = useCallback(async () => {
    const parsed = parsePairingLink(link);
    if (!parsed.ok) {
      setScreen({ kind: "unpaired", error: describePairingLinkError(parsed.error), notice: null });
      return;
    }
    setScreen({ kind: "connecting", step: "Pairing" });
    try {
      const session = await pair(parsed.target);
      await saveSession(session);
      sessionRef.current = session;
      setLink("");
      startRenew();
      await goOnline(session, 0);
    } catch (cause) {
      setScreen({ kind: "unpaired", error: describePairFailure(cause), notice: null });
    }
  }, [goOnline, link, startRenew]);

  const pasteLink = useCallback(async () => {
    setLink(await Clipboard.getStringAsync());
  }, []);

  const signOut = useCallback(
    async (session: StoredSession) => {
      stopRenew();
      disposeRpc();
      setScreen({ kind: "connecting", step: "Signing out" });
      const outcome = await revokeRemoteSession(session);
      await endSession({ kind: "unpaired", error: null, notice: describeSignOut(outcome) });
    },
    [disposeRpc, endSession, stopRenew],
  );

  const confirmSignOut = useCallback(
    (session: StoredSession) => {
      Alert.alert(
        "Sign out this phone?",
        "This removes the sign-in from this phone. Your bots keep running.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign out", style: "destructive", onPress: () => void signOut(session) },
        ],
      );
    },
    [signOut],
  );

  const pairAgain = useCallback(() => {
    setScreen({ kind: "unpaired", error: null, notice: null });
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
        {screen.kind === "online" ? (
          <View style={styles.flex}>
            <View style={styles.header}>
              <View style={styles.flex}>
                <Text style={styles.headerTitle}>Bots</Text>
                <Text style={styles.headerSub} numberOfLines={1}>
                  {screen.bots.length} bots · {screen.session.label}
                  {screen.serverVersion === null ? "" : ` · v${screen.serverVersion}`}
                </Text>
              </View>
              <Pressable
                onPress={() => confirmSignOut(screen.session)}
                accessibilityRole="button"
                style={styles.pillButton}
              >
                <Text style={styles.pillText}>Sign out</Text>
              </Pressable>
            </View>
            <FlatList
              data={screen.bots}
              keyExtractor={(bot) => bot.botId}
              getItemLayout={(_, index) => ({
                length: ROW_HEIGHT,
                offset: ROW_HEIGHT * index,
                index,
              })}
              renderItem={({ item }) => (
                <BotRow bot={item} chats={chatCount(screen.threads, item.botId)} />
              )}
              initialNumToRender={20}
              windowSize={9}
            />
          </View>
        ) : (
          <View style={styles.pairScreen}>
            <Text style={styles.brand}>hbots</Text>
            {screen.kind === "booting" || screen.kind === "connecting" ? (
              <View style={styles.status}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.statusText}>
                  {screen.kind === "connecting" ? screen.step : "Starting"}
                </Text>
              </View>
            ) : screen.kind === "laptopOffline" ? (
              <>
                <Text style={styles.headline}>Can't reach your laptop</Text>
                <Text style={styles.help}>
                  It may be off or restarting. You are still paired with {screen.session.label}.
                  hbots keeps trying.
                </Text>
                <Pressable
                  onPress={() => void goOnline(screen.session, 0)}
                  accessibilityRole="button"
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryText}>Retry</Text>
                </Pressable>
                <Pressable
                  onPress={pairAgain}
                  accessibilityRole="button"
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryText}>Pair again</Text>
                </Pressable>
              </>
            ) : screen.kind === "signedOut" ? (
              <>
                <Text style={styles.headline}>You were signed out</Text>
                <Text style={styles.help}>
                  {
                    "This phone's sign-in ended. Make a new pairing link in hbots Settings > Connections."
                  }
                </Text>
                <Pressable
                  onPress={pairAgain}
                  accessibilityRole="button"
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryText}>Pair again</Text>
                </Pressable>
              </>
            ) : (
              <>
                {screen.notice !== null ? (
                  <View style={styles.noticeBox}>
                    <Text style={styles.notice}>{screen.notice}</Text>
                  </View>
                ) : null}
                <Text style={styles.label}>Pairing link</Text>
                <TextInput
                  value={link}
                  onChangeText={setLink}
                  placeholder="https://your-server/pair#token=..."
                  placeholderTextColor={COLORS.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  multiline
                  style={styles.input}
                />
                <Pressable
                  onPress={() => void pasteLink()}
                  accessibilityRole="button"
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryText}>Paste</Text>
                </Pressable>
                <Pressable
                  onPress={() => void submitLink()}
                  accessibilityRole="button"
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryText}>Pair</Text>
                </Pressable>
                {screen.error !== null ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.error}>{screen.error}</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  header: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  headerSub: { color: COLORS.muted, fontSize: 12, marginTop: 1 },
  pillButton: {
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    minHeight: 40,
    justifyContent: "center",
  },
  pillText: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  row: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: COLORS.accent, fontSize: 15, fontWeight: "700" },
  rowBody: { flex: 1, paddingHorizontal: 12, gap: 3 },
  botName: { color: COLORS.text, fontSize: 16, fontWeight: "600" },
  botMeta: { color: COLORS.muted, fontSize: 12 },
  rowRight: { alignItems: "flex-end", minWidth: 38 },
  chatCount: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  chatLabel: { color: COLORS.muted, fontSize: 10 },
  pairScreen: { flex: 1, padding: 20, gap: 12 },
  brand: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginTop: 12,
    marginBottom: 6,
  },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusText: { color: COLORS.accent, fontSize: 14, fontWeight: "600" },
  label: { color: COLORS.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  input: {
    minHeight: 76,
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 12,
    color: COLORS.text,
    padding: 12,
    fontSize: 14,
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 6,
  },
  primaryText: { color: "#171509", fontSize: 16, fontWeight: "700" },
  headline: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  help: { color: COLORS.muted, fontSize: 14, lineHeight: 20 },
  secondaryButton: {
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryText: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  noticeBox: {
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 12,
  },
  notice: { color: COLORS.text, fontSize: 13, lineHeight: 18 },
  errorBox: {
    backgroundColor: "#2a1714",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5a2a22",
    borderRadius: 10,
    padding: 12,
  },
  error: { color: COLORS.danger, fontSize: 13, lineHeight: 18 },
});

export default App;
