import type { PersonalBot, PersonalBotThread } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import {
  clearSession,
  connect,
  loadSession,
  parsePairingUrl,
  resume,
  saveSession,
  type Session,
} from "./pairing";
import { connectPersonalRpc, type PersonalRpc } from "./rpc";

const APP_START_MS = Date.now();

type Phase = "booting" | "pair" | "connecting" | "ready";
type Screen =
  | { readonly kind: "list" }
  | { readonly kind: "bot"; readonly botId: string }
  | { readonly kind: "scroll" };

interface Timings {
  readonly descriptorMs?: number;
  readonly tokenMs?: number;
  readonly ticketMs?: number;
  readonly listMs?: number;
}

interface UiState {
  readonly phase: Phase;
  readonly step: string;
  readonly error: string | null;
  readonly session: Session | null;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly threads: ReadonlyArray<PersonalBotThread>;
  readonly timings: Timings;
  readonly bootToBotsMs: number | null;
  readonly refreshCount: number;
}

const INITIAL: UiState = {
  phase: "booting",
  step: "Starting",
  error: null,
  session: null,
  bots: [],
  threads: [],
  timings: {},
  bootToBotsMs: null,
  refreshCount: 0,
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function modelLine(bot: PersonalBot): string {
  const model = bot.modelSelection.model;
  const instance = String(bot.modelSelection.instanceId);
  return bot.title.length > 0 ? `${bot.title} · ${instance}/${model}` : `${instance}/${model}`;
}

function BotRow({ bot, threadCount }: { readonly bot: PersonalBot; readonly threadCount: number }) {
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
        <Text style={styles.threadCount}>{threadCount}</Text>
        <Text style={styles.threadLabel}>chats</Text>
      </View>
    </View>
  );
}

function DetailScreen({
  bot,
  threadCount,
  onBack,
}: {
  readonly bot: PersonalBot;
  readonly threadCount: number;
  readonly onBack: () => void;
}) {
  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
        >
          <Text style={styles.backGlyph}>{"\u2190"}</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {bot.name}
        </Text>
      </View>
      <View style={styles.detailBody}>
        <View style={[styles.avatar, styles.avatarLarge]}>
          <Text style={styles.avatarTextLarge}>{initials(bot.name)}</Text>
        </View>
        <Text style={styles.detailName}>{bot.name}</Text>
        <Text style={styles.detailMeta}>{modelLine(bot)}</Text>
        <Text style={styles.detailMeta}>
          {threadCount} chats · {bot.enabled ? "enabled" : "paused"}
        </Text>
        <Text style={styles.detailDescription}>
          {bot.description.length > 0 ? bot.description : "No description."}
        </Text>
        <Text style={styles.detailHint}>
          Swipe back or press the system back gesture to return to the list.
        </Text>
      </View>
    </View>
  );
}

function ScrollTestScreen({
  bots,
  onBack,
}: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly onBack: () => void;
}) {
  const rows = Array.from(
    { length: 500 },
    (_, index) => bots[index % Math.max(bots.length, 1)],
  ).filter((bot): bot is PersonalBot => bot !== undefined);
  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
        >
          <Text style={styles.backGlyph}>{"\u2190"}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Scroll test · 500 rows</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(_, index) => String(index)}
        getItemLayout={(_, index) => ({ length: 76, offset: 76 * index, index })}
        renderItem={({ item, index }) => <BotRow bot={item} threadCount={(index % 9) + 1} />}
        initialNumToRender={16}
        maxToRenderPerBatch={16}
        windowSize={7}
        removeClippedSubviews
      />
    </View>
  );
}

function App() {
  const [state, setState] = useState<UiState>(INITIAL);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [pairingUrl, setPairingUrl] = useState("");
  const [useDpop, setUseDpop] = useState(true);
  const [autoConnect, setAutoConnect] = useState(true);
  const rpcRef = useRef<PersonalRpc | null>(null);
  const mountedRef = useRef(true);
  const bootStartedRef = useRef(false);

  const disposeRpc = useCallback(() => {
    const rpc = rpcRef.current;
    rpcRef.current = null;
    if (rpc !== null) {
      void rpc.dispose();
    }
  }, []);

  const loadBots = useCallback(async (rpc: PersonalRpc, session: Session, boot: boolean) => {
    const { result, ms } = await rpc.listBots();
    if (!mountedRef.current) {
      return;
    }
    setState((current) => ({
      ...current,
      phase: "ready",
      error: null,
      session,
      bots: result.bots,
      threads: result.threads,
      timings: { ...current.timings, listMs: ms },
      bootToBotsMs: boot ? Date.now() - APP_START_MS : current.bootToBotsMs,
      refreshCount: current.refreshCount + 1,
    }));
    console.log(
      `SPIKE bots=${String(result.bots.length)} listMs=${String(ms)} bootMs=${String(Date.now() - APP_START_MS)}`,
    );
  }, []);

  const resumeSession = useCallback(
    async (session: Session) => {
      setState((current) => ({
        ...current,
        phase: "connecting",
        step: "WebSocket ticket",
        error: null,
      }));
      const resumed = await resume(session);
      setState((current) => ({ ...current, step: "Opening WebSocket" }));
      const rpc = await connectPersonalRpc(resumed.socketUrl);
      rpcRef.current = rpc;
      setState((current) => ({
        ...current,
        step: "personalBots.list",
        timings: { ...current.timings, ticketMs: resumed.ticketMs },
      }));
      await loadBots(rpc, session, true);
    },
    [loadBots],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (bootStartedRef.current) {
      return;
    }
    bootStartedRef.current = true;
    void (async () => {
      try {
        const session = await loadSession();
        if (!autoConnect || session === null) {
          setState((current) => ({
            ...current,
            phase: "pair",
            step: "Waiting for a pairing link",
          }));
          return;
        }
        await resumeSession(session);
      } catch (cause) {
        setState((current) => ({
          ...current,
          phase: "pair",
          error: cause instanceof Error ? cause.message : String(cause),
          step: "Waiting for a pairing link",
        }));
      }
    })();
    return () => {
      mountedRef.current = false;
      disposeRpc();
    };
  }, [autoConnect, disposeRpc, resumeSession]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      console.log("SPIKE back-handler called");
      if (screen.kind !== "list") {
        setScreen({ kind: "list" });
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [screen]);

  const pair = useCallback(async () => {
    setState((current) => ({
      ...current,
      phase: "connecting",
      step: "Reading descriptor",
      error: null,
    }));
    try {
      const target = parsePairingUrl(pairingUrl);
      setState((current) => ({ ...current, step: "Exchanging pairing token" }));
      const connected = await connect(target, { useDpop });
      setState((current) => ({
        ...current,
        step: "Opening WebSocket",
        session: connected.session,
        timings: {
          descriptorMs: connected.timings.descriptorMs,
          tokenMs: connected.timings.tokenMs,
          ticketMs: connected.timings.ticketMs,
        },
      }));
      await saveSession(connected.session);
      const rpc = await connectPersonalRpc(connected.socketUrl);
      rpcRef.current = rpc;
      setState((current) => ({ ...current, step: "personalBots.list" }));
      await loadBots(rpc, connected.session, true);
    } catch (cause) {
      setState((current) => ({
        ...current,
        phase: "pair",
        error: cause instanceof Error ? cause.message : String(cause),
        step: "Pairing failed",
      }));
    }
  }, [loadBots, pairingUrl, useDpop]);

  const reload = useCallback(async () => {
    const rpc = rpcRef.current;
    const session = state.session;
    if (rpc === null || session === null) {
      return;
    }
    try {
      await loadBots(rpc, session, false);
    } catch (cause) {
      setState((current) => ({
        ...current,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }, [loadBots, state.session]);

  const unpair = useCallback(async () => {
    disposeRpc();
    await clearSession();
    setScreen({ kind: "list" });
    setState({ ...INITIAL, phase: "pair", step: "Waiting for a pairing link" });
  }, [disposeRpc]);

  const ready = state.phase === "ready" && state.session !== null;
  const selectedBot =
    screen.kind === "bot" ? (state.bots.find((bot) => bot.botId === screen.botId) ?? null) : null;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
        {ready && screen.kind === "scroll" ? (
          <ScrollTestScreen bots={state.bots} onBack={() => setScreen({ kind: "list" })} />
        ) : ready && selectedBot !== null ? (
          <DetailScreen
            bot={selectedBot}
            threadCount={threadsFor(state.threads, selectedBot.botId)}
            onBack={() => setScreen({ kind: "list" })}
          />
        ) : ready && state.session !== null ? (
          <View style={styles.flex}>
            <View style={styles.header}>
              <View style={styles.flex}>
                <Text style={styles.headerTitle}>Bots</Text>
                <Text style={styles.headerSub}>
                  {state.bots.length} bots · {state.timings.listMs ?? 0} ms · boot{" "}
                  {state.bootToBotsMs ?? 0} ms
                </Text>
              </View>
              <Pressable
                onPress={() => void reload()}
                accessibilityRole="button"
                style={styles.pillButton}
              >
                <Text style={styles.pillText}>Reload</Text>
              </Pressable>
            </View>
            <View style={styles.sessionStrip}>
              <Text style={styles.sessionText} numberOfLines={1}>
                {state.session.label} · v{state.session.serverVersion} · {state.session.tokenType}
              </Text>
              <Text style={styles.sessionText}>
                {state.session.expiresAt > Date.now()
                  ? `${String(Math.round((state.session.expiresAt - Date.now()) / 60000))} min token`
                  : "token expired"}
              </Text>
            </View>
            {state.error !== null ? <Text style={styles.error}>{state.error}</Text> : null}
            <FlatList
              data={state.bots}
              keyExtractor={(bot) => bot.botId}
              getItemLayout={(_, index) => ({ length: 76, offset: 76 * index, index })}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => setScreen({ kind: "bot", botId: item.botId })}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.name}`}
                >
                  <BotRow bot={item} threadCount={threadsFor(state.threads, item.botId)} />
                </Pressable>
              )}
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={9}
              ListFooterComponent={
                <View style={styles.footer}>
                  <Pressable
                    onPress={() => setScreen({ kind: "scroll" })}
                    style={styles.footerButton}
                    accessibilityRole="button"
                  >
                    <Text style={styles.footerText}>Scroll test · 500 rows</Text>
                  </Pressable>
                  <Text style={styles.footerTextDim}>
                    refreshes {state.refreshCount} · descriptor {state.timings.descriptorMs ?? 0} ms
                    · token {state.timings.tokenMs ?? 0} ms · ticket {state.timings.ticketMs ?? 0}{" "}
                    ms
                  </Text>
                  <Pressable
                    onPress={() => void unpair()}
                    style={styles.footerButton}
                    accessibilityRole="button"
                  >
                    <Text style={styles.dangerText}>Clear pairing</Text>
                  </Pressable>
                </View>
              }
            />
          </View>
        ) : (
          <View style={styles.pairScreen}>
            <Text style={styles.brand}>hbots spike</Text>
            <Text style={styles.phase}>
              {state.phase === "connecting" ? state.step : "Phase 0 instrument"}
            </Text>
            {state.phase === "booting" || state.phase === "connecting" ? (
              <View style={styles.rowCenter}>
                <ActivityIndicator color={COLORS.accent} />
              </View>
            ) : null}
            <Text style={styles.label}>Pairing link</Text>
            <TextInput
              value={pairingUrl}
              onChangeText={setPairingUrl}
              placeholder="http://10.0.2.2:38472/pair#token=..."
              placeholderTextColor={COLORS.muted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={styles.input}
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Bind the session with DPoP</Text>
              <Switch
                value={useDpop}
                onValueChange={setUseDpop}
                trackColor={{ true: "#6b5a2a", false: "#333330" }}
                thumbColor={COLORS.accent}
              />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Auto-connect on launch</Text>
              <Switch
                value={autoConnect}
                onValueChange={setAutoConnect}
                trackColor={{ true: "#6b5a2a", false: "#333330" }}
                thumbColor={COLORS.accent}
              />
            </View>
            <Pressable
              onPress={() => void pair()}
              disabled={state.phase === "connecting"}
              accessibilityRole="button"
              style={[
                styles.primaryButton,
                state.phase === "connecting" && styles.primaryButtonDisabled,
              ]}
            >
              <Text style={styles.primaryText}>
                {state.phase === "connecting" ? "Connecting..." : "Pair"}
              </Text>
            </Pressable>
            {state.error !== null ? (
              <View style={styles.errorBox}>
                <Text style={styles.error}>{state.error}</Text>
              </View>
            ) : null}
            <Text style={styles.help}>
              Token stays in expo-secure-store. This screen is a throwaway instrument, not a product
              screen.
            </Text>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function threadsFor(threads: ReadonlyArray<PersonalBotThread>, botId: string): number {
  return threads.filter((thread) => thread.botId === botId && thread.archivedAt === null).length;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  header: {
    height: 52,
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
    paddingVertical: 7,
    borderRadius: 999,
  },
  pillText: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  sessionStrip: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  sessionText: { color: COLORS.muted, fontSize: 11, flexShrink: 1 },
  row: {
    height: 76,
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
  avatarLarge: { width: 64, height: 64, borderRadius: 32 },
  avatarTextLarge: { color: COLORS.accent, fontSize: 22, fontWeight: "700" },
  rowBody: { flex: 1, paddingHorizontal: 12, gap: 3 },
  botName: { color: COLORS.text, fontSize: 16, fontWeight: "600" },
  botMeta: { color: COLORS.muted, fontSize: 12 },
  rowRight: { alignItems: "flex-end", minWidth: 38 },
  threadCount: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  threadLabel: { color: COLORS.muted, fontSize: 10 },
  backButton: {
    width: 40,
    height: 40,
    alignItems: "flex-start",
    justifyContent: "center",
    marginLeft: -6,
  },
  backGlyph: { color: COLORS.text, fontSize: 24 },
  detailBody: { padding: 20, alignItems: "center", gap: 6 },
  detailName: { color: COLORS.text, fontSize: 26, fontWeight: "700", marginTop: 8 },
  detailMeta: { color: COLORS.muted, fontSize: 13 },
  detailDescription: { color: COLORS.text, fontSize: 15, lineHeight: 22, marginTop: 18 },
  detailHint: { color: COLORS.muted, fontSize: 12, marginTop: 24, textAlign: "center" },
  pairScreen: { flex: 1, padding: 20, gap: 12 },
  brand: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginTop: 12,
  },
  phase: { color: COLORS.accent, fontSize: 13, fontWeight: "600", marginBottom: 6 },
  rowCenter: { alignItems: "center", paddingVertical: 4 },
  label: { color: COLORS.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  input: {
    minHeight: 76,
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 12,
    color: COLORS.text,
    padding: 12,
    fontSize: 13,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  switchLabel: { color: COLORS.text, fontSize: 14 },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 6,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryText: { color: "#171509", fontSize: 16, fontWeight: "700" },
  errorBox: {
    backgroundColor: "#2a1714",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5a2a22",
    borderRadius: 10,
    padding: 12,
  },
  error: {
    color: COLORS.danger,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  help: { color: COLORS.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  footer: { padding: 16, gap: 10, alignItems: "center" },
  footerButton: { paddingVertical: 8, paddingHorizontal: 14 },
  footerText: { color: COLORS.accent, fontSize: 13, fontWeight: "600" },
  footerTextDim: { color: COLORS.muted, fontSize: 10, textAlign: "center" },
  dangerText: { color: COLORS.danger, fontSize: 13 },
});

export default App;
