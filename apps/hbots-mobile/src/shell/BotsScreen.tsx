import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  botStatus,
  buildBotSummaries,
  partitionPinnedSummaries,
  type BotSummary,
} from "@hbots/personal-client/bots/botSummaries";
import {
  buildChatsSnapshot,
  partitionPinnedSnapshotRows,
  readChatsSnapshot,
  writeChatsSnapshot,
  type ChatsSnapshot,
} from "@hbots/personal-client/bots/chatsSnapshot";
import { isBotPinned, type PersonalBot } from "@t3tools/contracts";
import { IconRefresh, IconSettings, IconUsers } from "@tabler/icons-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "./ScreenHeader";
import { tokens } from "./tokens";

const SKELETON_ROWS = 6;

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function timeLabel(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function statusColor(summary: BotSummary, now: number): string {
  const status = botStatus(summary, now);
  if (status.tone === "review") return tokens.needs;
  if (status.tone === "waiting") return tokens.textSecondary;
  if (summary.live) return tokens.working;
  return tokens.textTertiary;
}

function previewText(summary: BotSummary): string {
  const message = summary.newestMessage;
  if (message?.hidden === true) return "New message";
  if (message !== null && message !== undefined && message.text.trim().length > 0) {
    return message.text;
  }
  return summary.newestThread?.title ?? "No chats yet";
}

function Avatar({ bot, size }: { readonly bot: PersonalBot; readonly size: number }) {
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 3,
          backgroundColor: bot.avatarColor,
        },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size / 2.8 }]} maxFontSizeMultiplier={1.3}>
        {initials(bot.name)}
      </Text>
    </View>
  );
}

function PinnedTile({
  summary,
  onPress,
}: {
  readonly summary: BotSummary;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${summary.bot.name}, pinned`}
      style={styles.tile}
    >
      <Avatar bot={summary.bot} size={48} />
      <Text style={styles.tileName} numberOfLines={2} maxFontSizeMultiplier={1.3}>
        {summary.bot.name}
      </Text>
    </Pressable>
  );
}

function BotRow({
  summary,
  now,
  onPress,
}: {
  readonly summary: BotSummary;
  readonly now: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${summary.bot.name}, ${botStatus(summary, now).label}, ${previewText(summary)}`}
      accessibilityHint="Opens the chat"
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={styles.row}
    >
      <Avatar bot={summary.bot} size={48} />
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {summary.bot.name}
          {summary.bot.lead === true ? "  ·  lead" : ""}
        </Text>
        <View style={styles.rowLine}>
          <Text
            style={[styles.rowStatus, { color: statusColor(summary, now) }]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.6}
          >
            {botStatus(summary, now).label}
          </Text>
          <Text style={styles.rowPreview} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {previewText(summary)}
          </Text>
        </View>
      </View>
      <Text style={styles.rowTime} maxFontSizeMultiplier={1.6}>
        {timeLabel(summary.lastActivityMs)}
      </Text>
    </Pressable>
  );
}

function SnapshotRow({
  name,
  subtitle,
  preview,
  avatarColor,
  time,
  pinned,
}: {
  readonly name: string;
  readonly subtitle: string;
  readonly preview: string;
  readonly avatarColor: string;
  readonly time: number | null;
  readonly pinned: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={[styles.avatar, styles.snapshotAvatar, { backgroundColor: avatarColor }]}>
        <Text style={styles.avatarText} maxFontSizeMultiplier={1.3}>
          {initials(name)}
        </Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {name}
          {pinned ? "  ·  pinned" : ""}
        </Text>
        <View style={styles.rowLine}>
          <Text style={styles.rowStatus} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            Ready
          </Text>
          <Text style={styles.rowPreview} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {preview.length > 0 ? preview : subtitle}
          </Text>
        </View>
      </View>
      <Text style={styles.rowTime} maxFontSizeMultiplier={1.6}>
        {timeLabel(time)}
      </Text>
    </View>
  );
}

function Skeleton() {
  return (
    <View>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={[styles.avatar, styles.skeletonAvatar]} />
          <View style={styles.rowBody}>
            <View style={[styles.skeletonLine, { width: "42%" }]} />
            <View style={[styles.skeletonLine, { width: "68%" }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function BotsScreen({
  native,
  onOpenChat,
  onOpenBot,
  onOpenTeam,
  onOpenSettings,
}: {
  readonly native: NativePersonal;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onOpenBot: (botId: string) => void;
  readonly onOpenTeam: () => void;
  readonly onOpenSettings: () => void;
}) {
  const environmentId = native.environmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const providers = native.useProviders();
  const shellState = useAtomValue(native.shell.stateValueAtom(environmentId));
  const connection = native.useConnectionState();
  const [snapshot, setSnapshot] = useState<ChatsSnapshot | null>(() =>
    readChatsSnapshot(native.client.ports.kv, environmentId),
  );
  const [now, setNow] = useState(() => Date.now());
  const persistedKey = useRef<string | null>(null);
  const previousPhase = useRef(connection.phase);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refreshList = list.refresh;
  useEffect(() => {
    if (previousPhase.current !== "connected" && connection.phase === "connected") {
      refreshList();
    }
    previousPhase.current = connection.phase;
  }, [connection.phase, refreshList]);

  const shells = useMemo<ReadonlyArray<EnvironmentThreadShell>>(
    () => native.shellsOf(shellState.snapshot._tag === "Some" ? shellState.snapshot.value : null),
    [native, shellState.snapshot],
  );

  const summaries = useMemo(
    () =>
      list.data === null
        ? []
        : buildBotSummaries({
            bots: list.data.bots,
            links: list.data.threads,
            shells,
            providers,
            nowMs: now,
          }),
    [list.data, now, providers, shells],
  );

  const split = useMemo(() => partitionPinnedSummaries(summaries), [summaries]);

  useEffect(() => {
    if (list.data === null) return;
    const stored = [...split.pinned, ...split.rest].map((summary) => ({
      botId: summary.bot.botId,
      name: summary.bot.name,
      avatarShape: summary.bot.avatarShape,
      avatarColor: summary.bot.avatarColor,
      subtitle: summary.bot.title,
      previewLabel: null,
      previewAtMs: summary.lastActivityMs,
      threadId: summary.newestThread?.id ?? null,
      threadTitle:
        summary.newestMessage?.hidden === true ? null : (summary.newestThread?.title ?? null),
      pinned: isBotPinned(summary.bot),
    }));
    const key = JSON.stringify(stored);
    if (persistedKey.current === key) return;
    persistedKey.current = key;
    const cache = buildChatsSnapshot({
      environmentId,
      savedAtMs: Date.now(),
      rows: stored,
    });
    writeChatsSnapshot(native.client.ports.kv, environmentId, cache);
    setSnapshot(cache);
  }, [environmentId, list.data, native, split]);

  const openSummary = (summary: BotSummary) => {
    const thread = summary.newestThread;
    if (thread === null) {
      onOpenBot(summary.bot.botId);
      return;
    }
    onOpenChat(summary.bot.botId, thread.id);
  };

  const offline = connection.phase === "offline";
  const connecting = connection.phase === "connecting";
  const snapshotSplit = snapshot === null ? null : partitionPinnedSnapshotRows(snapshot.rows);
  const showingSnapshot = list.data === null && snapshot !== null;

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title="Bots"
        right={
          <>
            <Pressable
              onPress={onOpenTeam}
              accessibilityRole="button"
              accessibilityLabel="Team"
              style={styles.headerButton}
            >
              <IconUsers size={22} color={tokens.text} strokeWidth={2} />
            </Pressable>
            <Pressable
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={styles.headerButton}
            >
              <IconSettings size={22} color={tokens.text} strokeWidth={2} />
            </Pressable>
          </>
        }
      />
      {offline || connecting ? (
        <View style={styles.strip}>
          <Text style={styles.stripText} numberOfLines={1}>
            {offline ? "Offline · showing saved rows" : "Connecting…"}
          </Text>
          <Pressable
            onPress={native.retry}
            accessibilityRole="button"
            style={styles.stripButton}
            hitSlop={8}
          >
            {offline ? (
              <Text style={styles.stripAction}>Retry</Text>
            ) : (
              <IconRefresh size={16} color={tokens.text} />
            )}
          </Pressable>
        </View>
      ) : null}
      {list.error !== null && list.data === null && snapshot === null ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{list.error}</Text>
          <Pressable onPress={() => list.refresh()} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {showingSnapshot ? (
        <FlatList
          data={snapshotSplit?.rest ?? []}
          keyExtractor={(row) => row.botId}
          ListHeaderComponent={
            snapshotSplit !== null && snapshotSplit.pinned.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tiles}
              >
                {snapshotSplit.pinned.map((row) => (
                  <View key={row.botId} style={styles.tile}>
                    <View
                      style={[
                        styles.avatar,
                        styles.snapshotAvatar,
                        { backgroundColor: row.avatarColor },
                      ]}
                    >
                      <Text style={styles.avatarText}>{initials(row.name)}</Text>
                    </View>
                    <Text style={styles.tileName} numberOfLines={2} maxFontSizeMultiplier={1.3}>
                      {row.name}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            ) : null
          }
          renderItem={({ item }) => (
            <SnapshotRow
              name={item.name}
              subtitle={item.subtitle}
              preview={item.preview}
              avatarColor={item.avatarColor}
              time={item.previewAtMs}
              pinned={item.pinned}
            />
          )}
        />
      ) : list.data === null ? (
        <Skeleton />
      ) : summaries.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No bots yet</Text>
          <Text style={styles.emptyText}>Create one on your laptop, or tap + to start.</Text>
        </View>
      ) : (
        <FlatList
          data={split.rest}
          keyExtractor={(summary) => summary.bot.botId}
          ListHeaderComponent={
            split.pinned.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.tiles}
              >
                {split.pinned.map((summary) => (
                  <PinnedTile
                    key={summary.bot.botId}
                    summary={summary}
                    onPress={() => openSummary(summary)}
                  />
                ))}
              </ScrollView>
            ) : null
          }
          ListEmptyComponent={
            split.pinned.length > 0 ? null : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No bots yet</Text>
                <Text style={styles.emptyText}>Create one on your laptop, or tap + to start.</Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <BotRow summary={item} now={now} onPress={() => openSummary(item)} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  strip: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 16,
    paddingRight: 8,
    backgroundColor: tokens.raised,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  stripText: { color: tokens.textSecondary, fontSize: 12, flex: 1 },
  stripButton: { minHeight: 32, minWidth: 44, alignItems: "flex-end", justifyContent: "center" },
  stripAction: { color: tokens.text, fontSize: 12, fontWeight: "600" },
  errorBox: {
    margin: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    gap: 8,
  },
  errorText: { color: tokens.error, fontSize: 13 },
  retry: { minHeight: 44, justifyContent: "center" },
  retryText: { color: tokens.text, fontSize: 13, fontWeight: "600" },
  tiles: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 8 },
  tile: { width: 68, alignItems: "center", gap: 6 },
  tileName: { color: tokens.textSecondary, fontSize: 11, lineHeight: 14, textAlign: "center" },
  row: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  avatar: { alignItems: "center", justifyContent: "center" },
  snapshotAvatar: { width: 48, height: 48, borderRadius: 16, backgroundColor: tokens.fillMuted },
  avatarText: { color: tokens.text, fontSize: 17, fontWeight: "700" },
  rowBody: { flex: 1, gap: 4 },
  rowName: { color: tokens.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.2 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowStatus: { color: tokens.textTertiary, fontSize: 12, fontWeight: "500" },
  rowPreview: { color: tokens.textSecondary, fontSize: 13, flex: 1 },
  rowTime: { color: tokens.textTertiary, fontSize: 12 },
  empty: { padding: 32, alignItems: "center", gap: 8 },
  emptyTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  emptyText: { color: tokens.textSecondary, fontSize: 13, textAlign: "center" },
  skeletonAvatar: { width: 48, height: 48, borderRadius: 16, backgroundColor: tokens.fillMuted },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: tokens.fillMuted,
    marginVertical: 3,
  },
});
