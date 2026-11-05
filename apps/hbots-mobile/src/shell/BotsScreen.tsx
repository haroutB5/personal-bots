import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  botStatus,
  buildBotSummaries,
  filterBotSummaries,
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
import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import { previewOf, snapshotPreviewLabel } from "@hbots/personal-client/bots/botRowModel";
import { unreadChatsByBot, NO_CHAT_SEEN } from "@hbots/personal-client/bots/unreadChats";
import {
  currentProgressNote,
  currentTurnHasToolStep,
} from "@hbots/personal-client/bots/workingProgress";
import {
  isBotPinned,
  ThreadId,
  type PersonalBot,
  type PersonalBotNotificationMute,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { IconHierarchy, IconPlus, IconSearch, IconSettings } from "@tabler/icons-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { mergePersonalGroups } from "@hbots/personal-client/groups/personalGroups";
import { GroupAvatarCluster } from "../groups/GroupAvatarCluster";
import { groupChatsSections } from "../groups/groupScreenModel";
import { SwipeToDeleteRow } from "../components/SwipeToDeleteRow";
import { BotActionsSheet } from "../sheets/BotActionsSheet";
import { NewChatSheet } from "../sheets/NewChatSheet";
import { RenameChatSheet } from "../sheets/RenameChatSheet";
import { SnoozeSheet } from "../sheets/SnoozeSheet";
import type { ChatEnvironment } from "../chat/chatEnvironment";
import { BotAvatar } from "./BotAvatar";
import { InAppNotifications } from "./InAppNotifications";
import { NewItemsSheet } from "./NewItemsSheet";
import { botsHomeState, botTapTarget } from "./botsHomeState";
import { PersonalOfflineBanner } from "./PersonalOfflineBanner";
import { PersonalUsageStrip } from "./PersonalUsageStrip";
import { SystemStatsLine } from "./SystemStatsLine";
import { tokens } from "./tokens";

const SKELETON_ROWS = 4;

function statusColor(summary: BotSummary, now: number): string {
  return botStatus(summary, now).tone === "review" ? tokens.reviewText : tokens.textSecondary;
}

function PinnedTile({
  summary,
  now,
  onPress,
  onLongPress,
}: {
  readonly summary: BotSummary;
  readonly now: number;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}) {
  const status = botStatus(summary, now);
  const badge = status.tone === "review" ? "attention" : summary.live ? "working" : null;
  const unread = summary.unreadChats ?? 0;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${summary.bot.name}${badge === null ? "" : `, ${status.label}`}${unread > 0 ? `, ${unread} unread chats` : ""}`}
      style={styles.tile}
    >
      <View style={styles.tileAvatarBox}>
        <BotAvatar
          shape={summary.bot.avatarShape}
          color={summary.bot.avatarColor}
          size={56}
          label={summary.bot.name}
        />
        {badge !== null ? (
          <View
            style={[
              styles.tileBadge,
              badge === "attention" ? styles.tileBadgeAttention : styles.tileBadgeWorking,
            ]}
          />
        ) : null}
        {unread > 0 ? <View style={styles.tileUnread} /> : null}
      </View>
      <Text style={styles.tileName} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {summary.bot.name}
      </Text>
      <Text style={styles.tileModel} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {summary.modelShortLabel ?? " "}
      </Text>
    </Pressable>
  );
}

function BotRow({
  summary,
  now,
  last,
  onPress,
  onLongPress,
}: {
  readonly summary: BotSummary;
  readonly now: number;
  readonly last: boolean;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}) {
  const status = botStatus(summary, now);
  const unread = summary.unreadChats ?? 0;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${summary.bot.name}${summary.modelShortLabel === null ? "" : `, ${summary.modelShortLabel}`}, ${status.label}, ${previewOf(summary, () => "Task update")}${unread > 0 ? `, ${unread} unread chats` : ""}`}
      accessibilityHint="Opens the chat"
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={[styles.row, last ? styles.rowLast : null]}
    >
      <BotAvatar
        shape={summary.bot.avatarShape}
        color={summary.bot.avatarColor}
        size={56}
        label={summary.bot.name}
      />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {summary.bot.name}
          </Text>
          {summary.modelShortLabel !== null ? (
            <Text style={styles.rowModel} numberOfLines={1} maxFontSizeMultiplier={1.6}>
              {summary.modelShortLabel}
            </Text>
          ) : null}
          {summary.live ? <View style={styles.liveDot} /> : null}
          {summary.lastActivityMs !== null ? (
            <Text style={styles.rowTime} maxFontSizeMultiplier={1.6}>
              {formatRelativeTime(summary.lastActivityMs, now)}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowStatusLine}>
          {status.tone === "waiting" ? <View style={styles.waitingRing} /> : null}
          <Text
            style={[styles.rowStatus, { color: statusColor(summary, now) }]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.6}
          >
            {status.label}
          </Text>
          {unread > 0 ? (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText} maxFontSizeMultiplier={1.3}>
                {unread > 99 ? "99+" : unread}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowPreview} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {previewOf(summary, () => "Task update")}
        </Text>
      </View>
    </Pressable>
  );
}

function GroupChatRow({
  row,
  bots,
  onPress,
}: {
  readonly row: ReturnType<typeof groupChatsSections>["groups"][number];
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly onPress: () => void;
}) {
  const byId = new Map(bots.map((bot) => [bot.botId as string, bot] as const));
  const members = row.memberIds.flatMap((botId) => {
    const bot = byId.get(botId);
    return bot === undefined ? [] : [bot];
  });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${row.subtitle}, ${row.statusLabel}`}
      style={({ pressed }) => [styles.groupRow, pressed ? styles.groupRowPressed : null]}
    >
      <GroupAvatarCluster bots={members} memberCount={row.memberIds.length} size={40} />
      <View style={styles.groupRowText}>
        <View style={styles.groupRowTitleLine}>
          <Text style={styles.groupRowName} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.groupRowTime}>{row.timeLabel}</Text>
        </View>
        <Text style={styles.groupRowPreview} numberOfLines={1}>
          {row.preview}
        </Text>
        <View style={styles.groupRowStatusLine}>
          <View
            style={[
              styles.groupStatusDot,
              row.live
                ? styles.groupStatusLive
                : row.tone === "review"
                  ? styles.groupStatusReview
                  : null,
            ]}
          />
          <Text style={styles.groupRowStatus} numberOfLines={1}>
            {`${row.subtitle} · ${row.statusLabel}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function SnapshotRow({
  row,
  now,
  last,
  onPress,
}: {
  readonly row: ChatsSnapshot["rows"][number];
  readonly now: number;
  readonly last: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${row.preview.length > 0 ? row.preview : "No chats yet"}`}
      accessibilityHint="Opens the chat"
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={[styles.row, last ? styles.rowLast : null]}
    >
      <BotAvatar shape={row.avatarShape} color={row.avatarColor} size={56} label={row.name} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {row.name}
          </Text>
          {row.previewAtMs !== null ? (
            <Text style={styles.rowTime}>{formatRelativeTime(row.previewAtMs, now)}</Text>
          ) : null}
        </View>
        <Text style={[styles.rowStatus, { color: tokens.textSecondary }]} numberOfLines={1}>
          {row.subtitle}
        </Text>
        <Text style={styles.rowPreview} numberOfLines={1}>
          {row.preview.length > 0 ? row.preview : "No chats yet"}
        </Text>
      </View>
    </Pressable>
  );
}

function Skeleton() {
  return (
    <View style={styles.skeleton}>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.rowBody}>
            <View style={[styles.skeletonLine, { width: "42%" }]} />
            <View style={[styles.skeletonLine, { width: "68%" }]} />
            <View style={[styles.skeletonLine, { width: "80%" }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

interface NewChatTarget {
  readonly botId: string;
  readonly botName: string;
}

export function BotsScreen({
  native,
  chat,
  installedVersion,
  onOpenChat,
  onOpenChats,
  onOpenGroup,
  onNewGroup,
  onOpenTeam,
  onOpenSettings,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly installedVersion: string;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onOpenChats: (botId: string) => void;
  readonly onOpenGroup: (groupId: string) => void;
  readonly onNewGroup: () => void;
  readonly onOpenTeam: () => void;
  readonly onOpenSettings: () => void;
}) {
  const environmentId = native.environmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const routines = native.bots.usePersonalRoutinesList(environmentId);
  const groupsList = native.groups.usePersonalGroupsList(environmentId);
  const { feed: groupsFeed } = native.groups.usePersonalGroupsFeed(environmentId);
  const providers = native.useProviders();
  const shellState = useAtomValue(native.shell.stateValueAtom(environmentId));
  const connection = native.useConnectionState();
  const [snapshot, setSnapshot] = useState<ChatsSnapshot | null>(() =>
    readChatsSnapshot(native.client.ports.kv, environmentId),
  );
  const [now, setNow] = useState(() => Date.now());
  const groupSections = useMemo(() => {
    const merged = mergePersonalGroups(groupsList.data, groupsFeed);
    return groupChatsSections({
      groups: merged.groups,
      archivedGroups: merged.archivedGroups,
      rounds: merged.rounds,
      bots: list.data?.bots ?? [],
      nowMs: now,
    });
  }, [groupsFeed, groupsList.data, list.data?.bots, now]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionBot, setActionBot] = useState<BotSummary | null>(null);
  const [newChatBot, setNewChatBot] = useState<NewChatTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<BotSummary | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<BotSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const archiveThread = native.client.useAtomCommand(native.bots.personalBotArchiveThread, {
    reportFailure: false,
  });
  const deleteThread = native.client.useAtomCommand(native.bots.personalBotDeleteThread, {
    reportFailure: false,
  });
  const updateThreads = native.client.useAtomCommand(native.bots.personalBotUpdateThreads, {
    reportFailure: false,
  });
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const deleteBot = native.client.useAtomCommand(native.bots.personalBotDelete, {
    reportFailure: false,
  });
  const persistedKey = useRef<string | null>(null);
  const refreshedGeneration = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refreshList = list.refresh;
  useEffect(() => {
    if (
      connection.phase === "connected" &&
      shellState.status === "live" &&
      refreshedGeneration.current !== connection.generation
    ) {
      refreshedGeneration.current = connection.generation;
      refreshList();
    }
  }, [connection.generation, connection.phase, refreshList, shellState.status]);

  const baseShells = useMemo<ReadonlyArray<EnvironmentThreadShell>>(
    () => native.shellsOf(shellState.snapshot._tag === "Some" ? shellState.snapshot.value : null),
    [native, shellState.snapshot],
  );
  // The slim shell leaves out archived bot chats. Ask for a linked chat only
  // when its shell is genuinely missing, the same request the web makes.
  const missingThreadIds = useMemo(() => {
    if (list.data === null) return "";
    const present = new Set(baseShells.map((shell) => shell.id as string));
    return list.data.threads
      .filter((link) => link.archivedAt === null && !present.has(link.threadId))
      .map((link) => link.threadId as string)
      .toSorted()
      .join(",");
  }, [baseShells, list.data]);
  const extraShellsAtom = useMemo(
    () =>
      missingThreadIds.length === 0
        ? null
        : native.bots.personalBotsThreadShells({
            environmentId,
            input: {
              threadIds: missingThreadIds.split(",") as ThreadId[],
            },
          }),
    [environmentId, missingThreadIds, native],
  );
  const extraShells = native.client.useEnvironmentQuery(extraShellsAtom).data;
  const shells = useMemo<ReadonlyArray<EnvironmentThreadShell>>(
    () =>
      extraShells === null
        ? baseShells
        : [...baseShells, ...extraShells.threads.map((thread) => ({ ...thread, environmentId }))],
    [baseShells, environmentId, extraShells],
  );

  const baseSummaries = useMemo(
    () =>
      list.data === null
        ? []
        : buildBotSummaries({
            bots: list.data.bots,
            links: list.data.threads,
            shells,
            providers,
            routines: routines.data?.routines ?? [],
            nowMs: now,
          }),
    [list.data, now, providers, shells, routines.data],
  );

  const progressKey = useMemo(
    () =>
      baseSummaries
        .flatMap((summary) =>
          summary.live && summary.liveThread != null
            ? [`${summary.liveThread.id}@${summary.liveThread.updatedAt}`]
            : [],
        )
        .toSorted()
        .join("|"),
    [baseSummaries],
  );
  const progressAtom = useMemo(
    () =>
      progressKey.length === 0
        ? null
        : native.bots.personalBotsWorkingProgress({
            environmentId,
            input: {
              threadIds: progressKey
                .split("|")
                .map((entry) => entry.slice(0, entry.indexOf("@")) as ThreadId),
            },
          }),
    [environmentId, native, progressKey],
  );
  const progressData = native.client.useEnvironmentQuery(progressAtom).data;
  const progress = useMemo(
    () =>
      progressData === null
        ? null
        : new Map(
            progressData.notes.map((entry) => [
              entry.threadId as string,
              { note: entry.note, turnId: entry.turnId, toolStep: entry.toolStep },
            ]),
          ),
    [progressData],
  );
  const notedSummaries = useMemo(
    () =>
      progress === null
        ? baseSummaries
        : baseSummaries.map((summary) => {
            const liveThread = summary.liveThread ?? null;
            if (liveThread === null) return summary;
            const entry = progress.get(liveThread.id);
            const note = currentProgressNote(entry, liveThread);
            const thinking = summary.thinking && !currentTurnHasToolStep(entry, liveThread);
            if (note === undefined && thinking === summary.thinking) return summary;
            return { ...summary, ...(note === undefined ? {} : { progressNote: note }), thinking };
          }),
    [baseSummaries, progress],
  );

  const unreadByBot = useMemo(
    () =>
      list.data === null
        ? new Map<string, ReadonlySet<string>>()
        : unreadChatsByBot({
            bots: list.data.bots,
            links: list.data.threads,
            tasks: [],
            shells,
            seen: NO_CHAT_SEEN,
          }),
    [list.data, shells],
  );

  const summaries = useMemo(
    () =>
      unreadByBot.size === 0
        ? notedSummaries
        : notedSummaries.map((summary) => {
            const count = unreadByBot.get(summary.bot.botId)?.size ?? 0;
            return count === 0 ? summary : { ...summary, unreadChats: count };
          }),
    [notedSummaries, unreadByBot],
  );

  const visible = useMemo(() => filterBotSummaries(summaries, query), [query, summaries]);
  const split = useMemo(() => partitionPinnedSummaries(visible), [visible]);

  useEffect(() => {
    if (list.data === null) return;
    const stored = [...split.pinned, ...split.rest].map((summary) => ({
      botId: summary.bot.botId,
      name: summary.bot.name,
      avatarShape: summary.bot.avatarShape,
      avatarColor: summary.bot.avatarColor,
      subtitle: summary.bot.title,
      previewLabel: snapshotPreviewLabel(summary, () => "Task update"),
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

  const openBot = (target: NewChatTarget, newestThreadId: string | null) => {
    const tap = botTapTarget(newestThreadId);
    if (tap.kind === "chat") onOpenChat(target.botId, tap.threadId);
    else setNewChatBot(target);
  };

  const openSummary = (summary: BotSummary) =>
    openBot(
      { botId: summary.bot.botId, botName: summary.bot.name },
      summary.newestThread?.id ?? null,
    );

  const newestThreadOf = (summary: BotSummary) => {
    const thread = summary.newestThread;
    if (thread === null) return null;
    const shell = shells.find((candidate) => candidate.id === thread.id) ?? null;
    return shell === null ? null : { shell, threadId: thread.id as string };
  };

  const failureText = (result: { readonly _tag: string }, fallback: string): string | null => {
    if (result._tag === "Success") return null;
    const cause = squashAtomCommandFailure(result as never);
    return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
  };

  const togglePin = async (summary: BotSummary) => {
    const target = newestThreadOf(summary);
    if (target === null) return;
    setActionBot(null);
    const result = await updateThreads({
      environmentId,
      input: {
        threadIds: [ThreadId.make(target.threadId)],
        pinned: !target.shell.pinnedAt,
      },
    });
    setActionError(failureText(result, "Couldn't update that chat."));
  };

  const archiveNewest = async (summary: BotSummary) => {
    const target = newestThreadOf(summary);
    if (target === null) return;
    setActionBot(null);
    const result = await archiveThread({
      environmentId,
      input: { threadId: ThreadId.make(target.threadId), archived: true },
    });
    setActionError(failureText(result, "Couldn't archive that chat."));
  };

  const deleteNewest = async (summary: BotSummary) => {
    const target = newestThreadOf(summary);
    if (target === null) return;
    setActionBot(null);
    const ok = await native.client.ports.confirm.confirm({
      title: "Delete this chat?",
      body: "The chat and its messages are removed for good.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const result = await deleteThread({
      environmentId,
      input: { threadId: ThreadId.make(target.threadId) },
    });
    setActionError(failureText(result, "Couldn't delete that chat."));
  };

  const setMute = async (summary: BotSummary, mute: PersonalBotNotificationMute) => {
    setActionBot(null);
    const result = await updateBot({
      environmentId,
      input: { botId: summary.bot.botId, notificationsMute: mute },
    });
    setActionError(failureText(result, "Couldn't change notifications for that bot."));
  };

  const removeBot = async (summary: BotSummary) => {
    const ok = await native.client.ports.confirm.confirm({
      title: `Delete ${summary.bot.name}?`,
      body: "This deletes the bot and every chat you had with it.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const result = await deleteBot({
      environmentId,
      input: { botId: summary.bot.botId },
    });
    setActionError(failureText(result, "Couldn't delete that bot."));
  };

  const snapshotSplit = snapshot === null ? null : partitionPinnedSnapshotRows(snapshot.rows);
  const showingSnapshot = list.data === null && snapshot !== null;
  const loaded = list.data !== null;
  const state = botsHomeState({
    loaded,
    failed: list.error !== null,
    hasSnapshot: showingSnapshot,
    visibleCount: visible.length,
    query,
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.screen}
    >
      <PersonalOfflineBanner native={native} />
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title} maxFontSizeMultiplier={1.2}>
            Bots
          </Text>
          <Text style={styles.version} maxFontSizeMultiplier={1.2}>
            {`v${installedVersion}`}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={onOpenTeam}
            accessibilityRole="button"
            accessibilityLabel="Team"
            style={styles.headerButton}
          >
            <IconHierarchy size={22} color={tokens.text} strokeWidth={1.75} />
          </Pressable>
          <Pressable
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            style={styles.headerButton}
          >
            <IconSettings size={22} color={tokens.text} strokeWidth={1.75} />
          </Pressable>
          <Pressable
            onPress={() => setCreating(true)}
            accessibilityRole="button"
            accessibilityLabel="New"
            style={[styles.headerButton, styles.newButton]}
          >
            <IconPlus size={22} color={tokens.primaryText} strokeWidth={1.75} />
          </Pressable>
        </View>
      </View>

      <SystemStatsLine native={native} />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <PersonalUsageStrip native={native} now={now} />

        {actionError !== null ? (
          <Pressable
            onPress={() => setActionError(null)}
            accessibilityRole="alert"
            style={styles.errorBox}
          >
            <Text style={styles.errorText}>{actionError}</Text>
          </Pressable>
        ) : null}

        {state === "error" ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>Couldn't load your bots.</Text>
            <Pressable
              onPress={() => list.refresh()}
              accessibilityRole="button"
              style={styles.tryAgain}
            >
              <Text style={styles.tryAgainText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {loaded && summaries.length > 0 ? (
          <View style={styles.searchBox}>
            <IconSearch
              size={18}
              color={tokens.textSecondary}
              strokeWidth={1.75}
              style={styles.searchIcon}
            />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search bots and chats"
              placeholderTextColor={tokens.textSecondary}
              accessibilityLabel="Search bots and chats"
              maxFontSizeMultiplier={1.5}
              style={styles.searchInput}
            />
          </View>
        ) : null}

        {loaded ? (
          <View style={styles.groupsSection}>
            <View style={styles.groupsHeadingRow}>
              <Text style={styles.groupsHeading}>Groups</Text>
              <Pressable
                onPress={onNewGroup}
                accessibilityRole="button"
                accessibilityLabel="New group"
                style={styles.groupsNewButton}
              >
                <Text style={styles.groupsNewText}>New</Text>
              </Pressable>
            </View>
            {groupSections.groups.length === 0 ? (
              <Text style={styles.groupsEmpty}>
                Start a group when two bots should answer in the same conversation.
              </Text>
            ) : null}
            {groupSections.groups.map((row) => (
              <GroupChatRow
                key={row.groupId}
                row={row}
                bots={list.data?.bots ?? []}
                onPress={() => onOpenGroup(row.groupId)}
              />
            ))}
            {groupSections.archived.length > 0 ? (
              <>
                <Text style={styles.groupsArchivedLabel}>Archived groups</Text>
                {groupSections.archived.map((row) => (
                  <GroupChatRow
                    key={row.groupId}
                    row={row}
                    bots={list.data?.bots ?? []}
                    onPress={() => onOpenGroup(row.groupId)}
                  />
                ))}
              </>
            ) : null}
          </View>
        ) : null}

        {state === "snapshot" && snapshotSplit !== null ? (
          <>
            {snapshotSplit.pinned.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pinnedStrip}
                style={styles.pinnedScroller}
              >
                {snapshotSplit.pinned.map((row) => (
                  <Pressable
                    key={row.botId}
                    onPress={() => openBot({ botId: row.botId, botName: row.name }, row.threadId)}
                    accessibilityRole="button"
                    accessibilityLabel={row.name}
                    style={styles.tile}
                  >
                    <View style={styles.tileAvatarBox}>
                      <BotAvatar
                        shape={row.avatarShape}
                        color={row.avatarColor}
                        size={56}
                        label={row.name}
                      />
                    </View>
                    <Text style={styles.tileName} numberOfLines={1}>
                      {row.name}
                    </Text>
                    <Text style={styles.tileModel}> </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            {snapshotSplit.rest.map((row, index) => (
              <SnapshotRow
                key={row.botId}
                row={row}
                now={now}
                last={index === snapshotSplit.rest.length - 1}
                onPress={() => openBot({ botId: row.botId, botName: row.name }, row.threadId)}
              />
            ))}
          </>
        ) : state === "loading" ? (
          <Skeleton />
        ) : state === "empty" ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No bots yet</Text>
            <Text style={styles.emptyText}>
              Give a bot a name, a look and a provider, then chat with it from anywhere.
            </Text>
            <Pressable
              onPress={() => setCreating(true)}
              accessibilityRole="button"
              style={styles.createFirst}
            >
              <Text style={styles.createFirstText}>Create your first bot</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {split.pinned.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pinnedStrip}
                style={styles.pinnedScroller}
              >
                {split.pinned.map((summary) => (
                  <PinnedTile
                    key={summary.bot.botId}
                    summary={summary}
                    now={now}
                    onPress={() => openSummary(summary)}
                    onLongPress={() => setActionBot(summary)}
                  />
                ))}
              </ScrollView>
            ) : null}
            {split.rest.length > 0 ? (
              <View style={styles.list}>
                {split.rest.map((summary, index) => (
                  <SwipeToDeleteRow
                    key={summary.bot.botId}
                    label={`Delete ${summary.bot.name}`}
                    onDelete={() => void removeBot(summary)}
                  >
                    <BotRow
                      summary={summary}
                      now={now}
                      last={index === split.rest.length - 1}
                      onPress={() => openSummary(summary)}
                      onLongPress={() => setActionBot(summary)}
                    />
                  </SwipeToDeleteRow>
                ))}
              </View>
            ) : null}
            {state === "no-match" ? (
              <Text style={styles.noMatch}>{`No bots or chats match "${query.trim()}".`}</Text>
            ) : null}
          </>
        )}
      </ScrollView>

      <InAppNotifications
        native={native}
        currentPath="/bots"
        onOpen={(url) => {
          const match = /^\/bots\/([^/?#]+)\/([^/?#]+)/u.exec(url);
          if (match !== null)
            onOpenChat(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
        }}
      />
      <NewItemsSheet
        native={native}
        visible={creating}
        bots={list.data?.bots ?? []}
        onClose={() => setCreating(false)}
      />
      <BotActionsSheet
        visible={actionBot !== null}
        bot={actionBot?.bot ?? null}
        threadTitle={actionBot?.newestThread?.title ?? null}
        hasThread={actionBot?.newestThread !== null && actionBot?.newestThread !== undefined}
        pinned={
          actionBot?.newestThread?.pinnedAt !== null &&
          actionBot?.newestThread?.pinnedAt !== undefined
        }
        nowMs={now}
        onClose={() => setActionBot(null)}
        onNewChat={() => {
          const target = actionBot;
          setActionBot(null);
          if (target !== null) {
            setNewChatBot({ botId: target.bot.botId, botName: target.bot.name });
          }
        }}
        onAllChats={() => {
          const target = actionBot;
          setActionBot(null);
          if (target !== null) onOpenChats(target.bot.botId);
        }}
        onRename={() => {
          const target = actionBot;
          setActionBot(null);
          if (target !== null) setRenameTarget(target);
        }}
        onSnooze={() => {
          const target = actionBot;
          setActionBot(null);
          if (target !== null) setSnoozeTarget(target);
        }}
        onTogglePin={() => {
          if (actionBot !== null) void togglePin(actionBot);
        }}
        onArchive={() => {
          if (actionBot !== null) void archiveNewest(actionBot);
        }}
        onDeleteChat={() => {
          if (actionBot !== null) void deleteNewest(actionBot);
        }}
        onMute={(mute) => {
          if (actionBot !== null) void setMute(actionBot, mute);
        }}
      />
      {newChatBot !== null ? (
        <NewChatSheet
          native={native}
          visible
          botId={newChatBot.botId}
          botName={newChatBot.botName}
          openChatTitles={
            list.data?.threads
              .filter((link) => link.botId === newChatBot.botId && link.archivedAt === null)
              .map((link) => shells.find((shell) => shell.id === link.threadId)?.title ?? "") ?? []
          }
          onClose={() => setNewChatBot(null)}
          onCreated={(threadId) => onOpenChat(newChatBot.botId, threadId)}
        />
      ) : null}
      {renameTarget !== null ? (
        <RenameChatSheet
          native={native}
          chat={chat}
          visible
          threadId={renameTarget.newestThread?.id ?? ""}
          initialTitle={renameTarget.newestThread?.title ?? ""}
          takenTitles={
            list.data?.threads
              .filter(
                (link) =>
                  link.botId === renameTarget.bot.botId &&
                  link.archivedAt === null &&
                  link.threadId !== renameTarget.newestThread?.id,
              )
              .map((link) => shells.find((shell) => shell.id === link.threadId)?.title ?? "") ?? []
          }
          onClose={() => setRenameTarget(null)}
          onSaved={() => setActionError(null)}
        />
      ) : null}
      <SnoozeSheet
        native={native}
        visible={snoozeTarget !== null}
        threadIds={snoozeTarget?.newestThread == null ? [] : [snoozeTarget.newestThread.id]}
        onClose={() => setSnoozeTarget(null)}
        onSnoozed={() => setActionError(null)}
        onError={setActionError}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  header: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 20,
    paddingRight: 20,
  },
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: 6, flexShrink: 1 },
  title: { color: tokens.text, fontSize: 28, lineHeight: 28, fontWeight: "700" },
  version: { color: tokens.textSecondary, fontSize: 12, fontWeight: "500" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  newButton: { backgroundColor: tokens.primary },
  content: { paddingHorizontal: 20, paddingBottom: 24 },
  searchBox: { marginTop: 10, marginBottom: 0, justifyContent: "center" },
  searchIcon: { position: "absolute", left: 14, zIndex: 1 },
  searchInput: {
    minHeight: 44,
    borderRadius: 999,
    backgroundColor: tokens.fillMuted,
    paddingLeft: 40,
    paddingRight: 16,
    paddingVertical: 10,
    color: tokens.text,
    fontSize: 16,
  },
  pinnedScroller: { marginHorizontal: -20 },
  pinnedStrip: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
    gap: 10,
    flexGrow: 1,
    justifyContent: "center",
  },
  tile: { width: 72, alignItems: "center", gap: 6 },
  tileAvatarBox: { height: 56, justifyContent: "center" },
  tileBadge: {
    position: "absolute",
    right: 0,
    bottom: 2,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: tokens.bg,
  },
  tileBadgeAttention: { width: 16, height: 16, backgroundColor: tokens.needs },
  tileBadgeWorking: { width: 12, height: 12, backgroundColor: tokens.working },
  tileUnread: {
    position: "absolute",
    top: 2,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: tokens.bg,
    backgroundColor: tokens.primary,
  },
  tileName: {
    color: tokens.text,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "500",
    textAlign: "center",
    width: "100%",
  },
  tileModel: {
    color: tokens.textTertiary,
    fontSize: 11,
    lineHeight: 14,
    textAlign: "center",
    marginTop: -4,
  },
  list: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  row: {
    minHeight: 88,
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 0 },
  rowTop: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  rowName: {
    color: tokens.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    flexShrink: 1,
  },
  rowModel: {
    color: tokens.textTertiary,
    fontSize: 13,
    lineHeight: 22,
    marginLeft: 6,
    flexShrink: 1,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: tokens.working,
    marginLeft: 8,
  },
  rowTime: {
    color: tokens.textTertiary,
    fontSize: 13,
    lineHeight: 22,
    marginLeft: "auto",
    paddingLeft: 12,
  },
  rowStatusLine: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20 },
  waitingRing: {
    width: 8,
    height: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.textTertiary,
  },
  rowStatus: { fontSize: 14, lineHeight: 20, flexShrink: 1 },
  unreadBadge: {
    marginLeft: "auto",
    minWidth: 18,
    height: 18,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: { color: tokens.primaryText, fontSize: 11, fontWeight: "600" },
  rowPreview: { color: tokens.textPreview, fontSize: 14, lineHeight: 20 },
  errorBox: {
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    padding: 16,
  },
  errorText: { flex: 1, color: tokens.text, fontSize: 15 },
  tryAgain: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  tryAgainText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  empty: { marginTop: 40, alignItems: "center", gap: 12 },
  emptyTitle: { color: tokens.text, fontSize: 18, fontWeight: "600" },
  emptyText: {
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 280,
  },
  createFirst: {
    marginTop: 8,
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  createFirstText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  noMatch: { marginTop: 24, color: tokens.textSecondary, fontSize: 15, textAlign: "center" },
  skeleton: { marginTop: 12 },
  skeletonAvatar: { width: 56, height: 56, borderRadius: 999, backgroundColor: tokens.fillMuted },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: tokens.fillMuted,
    marginVertical: 4,
  },
  groupsSection: { marginTop: 12, gap: 2 },
  groupsHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  groupsHeading: {
    color: tokens.sectionLabel,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  groupsNewButton: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    justifyContent: "center",
  },
  groupsNewText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "600" },
  groupsEmpty: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  groupsArchivedLabel: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    paddingHorizontal: 4,
    paddingTop: 10,
    paddingBottom: 2,
  },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: 14,
  },
  groupRowPressed: { backgroundColor: tokens.fillMuted },
  groupRowText: { flex: 1, minWidth: 0, gap: 1 },
  groupRowTitleLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  groupRowName: { flex: 1, color: tokens.text, fontSize: 16, fontWeight: "600" },
  groupRowTime: { color: tokens.textTertiary, fontSize: 12 },
  groupRowPreview: { color: tokens.textPreview, fontSize: 14 },
  groupRowStatusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  groupStatusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: tokens.textTertiary },
  groupStatusLive: { backgroundColor: tokens.working },
  groupStatusReview: { backgroundColor: tokens.reviewText },
  groupRowStatus: { color: tokens.textSecondary, fontSize: 13, flexShrink: 1 },
});
