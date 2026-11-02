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
  buildBotsCache,
  clearBotsCache,
  readBotsCache,
  writeBotsCache,
  type BotRow,
} from "./botsCache";
import { secureBotsCacheStorage } from "./botsCacheStorage";
import {
  connectionStripText,
  connectingBotsView,
  offlineBotsView,
  savedBotsView,
  serverBotsView,
  STRIP_DELAY_MS,
  type BotsView,
} from "./botsView";
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
import { createSessionLifetime } from "./sessionLifetime";
import { describeSignOut, revokeRemoteSession } from "./signOut";

type Screen =
  | { readonly kind: "booting" }
  | { readonly kind: "unpaired"; readonly error: string | null; readonly notice: string | null }
  | { readonly kind: "connecting"; readonly step: string }
  | { readonly kind: "bots"; readonly session: StoredSession; readonly view: BotsView }
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

const sessionLifetime = createSessionLifetime({
  renew: renewSession,
  storage: { save: saveSession, clear: clearSession },
});

const COLORS = {
  bg: "#0f0f0e",
  card: "#191918",
  raised: "#202020",
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

function BotListRow({ row }: { readonly row: BotRow }) {
  return (
    <View style={styles.row}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials(row.name)}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.botName} numberOfLines={1}>
          {row.name}
          {row.lead ? "  ·  lead" : ""}
        </Text>
        <Text style={styles.botMeta} numberOfLines={1}>
          {row.title.length > 0 ? `${row.title} · ${row.model}` : row.model}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.chatCount}>{row.chats}</Text>
        <Text style={styles.chatLabel}>chats</Text>
      </View>
    </View>
  );
}

function ConnectionStrip({
  view,
  onRetry,
}: {
  readonly view: BotsView;
  readonly onRetry: () => void;
}) {
  const connectingSince = view.connection.kind === "connecting" ? view.connection.since : null;
  const [shownSince, setShownSince] = useState<number | null>(null);

  useEffect(() => {
    if (connectingSince === null) {
      return;
    }
    const timer = setTimeout(() => setShownSince(connectingSince), STRIP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connectingSince]);

  const visible =
    view.connection.kind === "offline" ||
    (connectingSince !== null && shownSince === connectingSince);
  const text = connectionStripText(view);
  if (!visible || text === null) {
    return null;
  }
  return (
    <View style={styles.strip}>
      <Text style={styles.stripText}>{text}</Text>
      {view.connection.kind === "offline" ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          hitSlop={8}
          style={styles.stripButton}
        >
          <Text style={styles.stripButtonText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "booting" });
  const [link, setLink] = useState("");
  const rpcRef = useRef<PersonalRpc | null>(null);
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
      await sessionLifetime.end();
      await clearBotsCache(secureBotsCacheStorage);
      setScreen(next);
    },
    [disposeRpc, stopRenew],
  );

  const handleFailure = useCallback(
    async (cause: unknown, session: StoredSession, attempt: number, keepList: boolean) => {
      disposeRpc();
      if (classifyFailure(cause).kind === "authDead") {
        await endSession({ kind: "signedOut" });
        return;
      }
      if (keepList) {
        setScreen((previous) =>
          previous.kind === "bots"
            ? { ...previous, view: offlineBotsView(previous.view, Date.now(), attempt) }
            : { kind: "laptopOffline", session, attempt },
        );
        return;
      }
      setScreen({ kind: "laptopOffline", session, attempt });
    },
    [disposeRpc, endSession],
  );

  const goOnline = useCallback(
    async (session: StoredSession, attempt: number, keepList: boolean) => {
      disposeRpc();
      if (keepList) {
        setScreen((previous) =>
          previous.kind === "bots"
            ? { ...previous, view: connectingBotsView(previous.view, Date.now()) }
            : previous,
        );
      } else {
        setScreen({ kind: "connecting", step: "Connecting" });
      }
      const epoch = sessionLifetime.epoch();
      try {
        const online = await openOnline(session);
        if (sessionLifetime.epoch() !== epoch) {
          await online.rpc.dispose();
          return;
        }
        rpcRef.current = online.rpc;
        const cache = buildBotsCache({
          environmentId: session.environmentId,
          serverVersion: online.serverVersion,
          savedAtMs: Date.now(),
          bots: online.bots,
          threads: online.threads,
        });
        await writeBotsCache(secureBotsCacheStorage, cache);
        if (sessionLifetime.epoch() !== epoch) {
          return;
        }
        setScreen({ kind: "bots", session, view: serverBotsView(cache) });
      } catch (cause) {
        if (sessionLifetime.epoch() !== epoch) {
          return;
        }
        await handleFailure(cause, session, attempt, keepList);
      }
    },
    [disposeRpc, handleFailure],
  );

  const startRenew = useCallback(() => {
    stopRenew();
    stopRenewRef.current = startRenewScheduler({
      foreground: appForeground,
      run: async () => {
        const epoch = sessionLifetime.epoch();
        try {
          await sessionLifetime.renew();
        } catch (cause) {
          if (sessionLifetime.epoch() === epoch) {
            throw cause;
          }
        }
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
      sessionLifetime.restore(session);
      startRenew();
      const cached = await readBotsCache(secureBotsCacheStorage, session.environmentId);
      if (!live) {
        return;
      }
      if (cached !== null) {
        setScreen({ kind: "bots", session, view: savedBotsView(cached, Date.now()) });
      }
      await goOnline(session, 0, cached !== null);
    })();
    return () => {
      live = false;
      stopRenew();
      disposeRpc();
    };
  }, [disposeRpc, goOnline, startRenew, stopRenew]);

  useEffect(() => {
    if (screen.kind === "laptopOffline") {
      const { session, attempt } = screen;
      const timer = setTimeout(
        () => void goOnline(session, attempt + 1, false),
        backoffMs(attempt),
      );
      return () => clearTimeout(timer);
    }
    if (screen.kind === "bots" && screen.view.connection.kind === "offline") {
      const { session } = screen;
      const { attempt } = screen.view.connection;
      const timer = setTimeout(() => void goOnline(session, attempt + 1, true), backoffMs(attempt));
      return () => clearTimeout(timer);
    }
  }, [goOnline, screen]);

  useEffect(() => {
    if (screen.kind !== "bots" || screen.view.connection.kind !== "online") {
      return;
    }
    const { session, view } = screen;
    const timer = setInterval(() => {
      const rpc = rpcRef.current;
      if (rpc === null) {
        return;
      }
      const epoch = sessionLifetime.epoch();
      refreshBots(rpc).then(
        (snapshot) => {
          if (sessionLifetime.epoch() !== epoch) {
            return;
          }
          const cache = buildBotsCache({
            environmentId: session.environmentId,
            serverVersion: view.serverVersion,
            savedAtMs: Date.now(),
            bots: snapshot.bots,
            threads: snapshot.threads,
          });
          void writeBotsCache(secureBotsCacheStorage, cache);
          setScreen({ kind: "bots", session, view: serverBotsView(cache) });
        },
        (cause: unknown) => {
          if (sessionLifetime.epoch() !== epoch) {
            return;
          }
          void handleFailure(cause, session, 0, true);
        },
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
      await sessionLifetime.adopt(session);
      setLink("");
      startRenew();
      await goOnline(session, 0, false);
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
      await sessionLifetime.end();
      await clearBotsCache(secureBotsCacheStorage);
      const outcome = await revokeRemoteSession(session);
      setScreen({ kind: "unpaired", error: null, notice: describeSignOut(outcome) });
    },
    [disposeRpc, stopRenew],
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
        {screen.kind === "bots" ? (
          <View style={styles.flex}>
            <View style={styles.header}>
              <View style={styles.flex}>
                <Text style={styles.headerTitle}>Bots</Text>
                <Text style={styles.headerSub} numberOfLines={1}>
                  {screen.view.rows.length} bots · {screen.session.label}
                  {screen.view.serverVersion === null ? "" : ` · v${screen.view.serverVersion}`}
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
            <ConnectionStrip
              view={screen.view}
              onRetry={() => void goOnline(screen.session, 0, true)}
            />
            <FlatList
              data={screen.view.rows}
              keyExtractor={(row) => row.botId}
              getItemLayout={(_, index) => ({
                length: ROW_HEIGHT,
                offset: ROW_HEIGHT * index,
                index,
              })}
              renderItem={({ item }) => <BotListRow row={item} />}
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
                  onPress={() => void goOnline(screen.session, 0, false)}
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
  strip: {
    minHeight: 32,
    paddingLeft: 16,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.raised,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  stripText: { color: COLORS.muted, fontSize: 12 },
  stripButton: { minHeight: 32, paddingHorizontal: 12, justifyContent: "center" },
  stripButtonText: { color: COLORS.text, fontSize: 12, fontWeight: "600" },
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
