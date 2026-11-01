import type { PersonalBot, PersonalBotThread } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { pair, resume, type Connection } from "./pairing";
import { describePairingLinkError, parsePairingLink } from "./pairingLink";
import { connectPersonalRpc, type PersonalRpc } from "./rpc";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session";

type AppState =
  | { readonly kind: "booting" }
  | { readonly kind: "pairing"; readonly error: string | null }
  | { readonly kind: "connecting"; readonly step: string }
  | {
      readonly kind: "ready";
      readonly session: StoredSession;
      readonly bots: ReadonlyArray<PersonalBot>;
      readonly threads: ReadonlyArray<PersonalBotThread>;
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  const [state, setState] = useState<AppState>({ kind: "booting" });
  const [link, setLink] = useState("");
  const rpcRef = useRef<PersonalRpc | null>(null);

  const disposeRpc = useCallback(() => {
    const rpc = rpcRef.current;
    rpcRef.current = null;
    if (rpc !== null) {
      void rpc.dispose();
    }
  }, []);

  const showBots = useCallback(async (connection: Connection) => {
    setState({ kind: "connecting", step: "Loading bots" });
    const rpc = await connectPersonalRpc(connection.socketUrl);
    rpcRef.current = rpc;
    const { result } = await rpc.listBots();
    setState({
      kind: "ready",
      session: connection.session,
      bots: result.bots,
      threads: result.threads,
    });
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const session = await loadSession();
        if (session === null) {
          setState({ kind: "pairing", error: null });
          return;
        }
        setState({ kind: "connecting", step: "Connecting" });
        const connection = await resume(session);
        if (live) {
          await showBots(connection);
        }
      } catch (cause) {
        if (live) {
          setState({ kind: "pairing", error: messageOf(cause) });
        }
      }
    })();
    return () => {
      live = false;
      disposeRpc();
    };
  }, [disposeRpc, showBots]);

  const submitLink = useCallback(async () => {
    const parsed = parsePairingLink(link);
    if (!parsed.ok) {
      setState({ kind: "pairing", error: describePairingLinkError(parsed.error) });
      return;
    }
    try {
      setState({ kind: "connecting", step: "Pairing" });
      const connection = await pair(parsed.target);
      await saveSession(connection.session);
      await showBots(connection);
    } catch (cause) {
      disposeRpc();
      setState({ kind: "pairing", error: messageOf(cause) });
    }
  }, [disposeRpc, link, showBots]);

  const unpair = useCallback(async () => {
    disposeRpc();
    await clearSession();
    setLink("");
    setState({ kind: "pairing", error: null });
  }, [disposeRpc]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
        {state.kind === "ready" ? (
          <View style={styles.flex}>
            <View style={styles.header}>
              <View style={styles.flex}>
                <Text style={styles.headerTitle}>Bots</Text>
                <Text style={styles.headerSub} numberOfLines={1}>
                  {state.bots.length} bots · {state.session.label} · v{state.session.serverVersion}
                </Text>
              </View>
              <Pressable
                onPress={() => void unpair()}
                accessibilityRole="button"
                style={styles.pillButton}
              >
                <Text style={styles.pillText}>Unpair</Text>
              </Pressable>
            </View>
            <FlatList
              data={state.bots}
              keyExtractor={(bot) => bot.botId}
              getItemLayout={(_, index) => ({
                length: ROW_HEIGHT,
                offset: ROW_HEIGHT * index,
                index,
              })}
              renderItem={({ item }) => (
                <BotRow bot={item} chats={chatCount(state.threads, item.botId)} />
              )}
              initialNumToRender={20}
              windowSize={9}
            />
          </View>
        ) : (
          <View style={styles.pairScreen}>
            <Text style={styles.brand}>hbots</Text>
            {state.kind === "booting" || state.kind === "connecting" ? (
              <View style={styles.status}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.statusText}>
                  {state.kind === "connecting" ? state.step : "Starting"}
                </Text>
              </View>
            ) : (
              <>
                <Text style={styles.label}>Pairing link</Text>
                <TextInput
                  value={link}
                  onChangeText={setLink}
                  placeholder="https://your-server/pair#token=..."
                  placeholderTextColor={COLORS.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  style={styles.input}
                />
                <Pressable
                  onPress={() => void submitLink()}
                  accessibilityRole="button"
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryText}>Pair</Text>
                </Pressable>
                {state.error !== null ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.error}>{state.error}</Text>
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
