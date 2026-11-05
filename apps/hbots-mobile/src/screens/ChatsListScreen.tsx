import { ThreadId, type PersonalBot } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { IconArchive, IconChevronLeft, IconPin, IconPlus } from "@tabler/icons-react-native";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import { conversationChatTitle } from "@hbots/personal-client/feed/chatNames";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { ChatActionsSheet, type ChatActionRow } from "../sheets/ChatActionsSheet";
import { NewChatSheet } from "../sheets/NewChatSheet";
import { RenameChatSheet } from "../sheets/RenameChatSheet";
import { SnoozeSheet } from "../sheets/SnoozeSheet";

interface Row extends ChatActionRow {
  readonly unread: boolean;
}

function failedMessage(result: { readonly _tag: string }, fallback: string): string | null {
  if (result._tag === "Success") return null;
  const cause = squashAtomCommandFailure(result as never);
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export function ChatsListScreen({
  native,
  chat,
  botId,
  onBack,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly botId: string;
  readonly onBack: () => void;
  readonly onOpenChat: (threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const [now] = useState(() => Date.now());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuRow, setMenuRow] = useState<ChatActionRow | null>(null);
  const [snoozeRow, setSnoozeRow] = useState<ChatActionRow | null>(null);
  const [renameRow, setRenameRow] = useState<ChatActionRow | null>(null);
  const [snoozeMany, setSnoozeMany] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);

  const archiveThreads = native.client.useAtomCommand(native.bots.personalBotArchiveThreads, {
    reportFailure: false,
  });
  const deleteThreads = native.client.useAtomCommand(native.bots.personalBotDeleteThreads, {
    reportFailure: false,
  });
  const archiveThread = native.client.useAtomCommand(native.bots.personalBotArchiveThread, {
    reportFailure: false,
  });
  const deleteThread = native.client.useAtomCommand(native.bots.personalBotDeleteThread, {
    reportFailure: false,
  });
  const updateThreads = native.client.useAtomCommand(native.bots.personalBotUpdateThreads, {
    reportFailure: false,
  });

  const bot: PersonalBot | null =
    list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  const shellState = useAtomValue(native.shell.stateValueAtom(native.environmentId));
  const shells = useMemo(
    () => native.shellsOf(Option.getOrNull(shellState.snapshot)),
    [native, shellState.snapshot],
  );

  const rows = useMemo<ReadonlyArray<Row>>(() => {
    if (list.data === null) return [];
    const byId = new Map(shells.map((shell) => [shell.id as string, shell] as const));
    return list.data.threads
      .filter((link) => link.botId === botId && link.archivedAt === null)
      .flatMap((link) => {
        const shell = byId.get(link.threadId);
        if (shell === undefined) return [];
        return [{ link, shell, unread: link.unread === true }];
      })
      .sort((left, right) => {
        const pinLeft = left.link.pinnedAt !== undefined;
        const pinRight = right.link.pinnedAt !== undefined;
        if (pinLeft !== pinRight) return pinLeft ? -1 : 1;
        const leftAt = DateTime.toEpochMillis(left.link.lastActivityAt ?? left.link.createdAt);
        const rightAt = DateTime.toEpochMillis(right.link.lastActivityAt ?? right.link.createdAt);
        return rightAt - leftAt;
      });
  }, [botId, list.data, shells]);

  const selecting = selected.size > 0;
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.link.threadId));
  const chosen = rows.filter((row) => selected.has(row.link.threadId));

  const toggle = (threadId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  const runBulk = async (kind: "archive" | "delete" | "pin" | "unread") => {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const threadIds = chosen.map((row) => ThreadId.make(row.link.threadId));
    try {
      if (kind === "archive" || kind === "delete") {
        const result =
          kind === "archive"
            ? await archiveThreads({
                environmentId: native.environmentId,
                input: { threadIds, archived: true },
              })
            : await deleteThreads({ environmentId: native.environmentId, input: { threadIds } });
        const failure = failedMessage(
          result,
          kind === "archive" ? "Couldn't archive those chats." : "Couldn't delete those chats.",
        );
        if (failure !== null) {
          setError(failure);
          return;
        }
      } else {
        const result = await updateThreads({
          environmentId: native.environmentId,
          input: {
            threadIds,
            ...(kind === "pin" ? { pinned: !chosen.every((row) => row.link.pinnedAt) } : {}),
            ...(kind === "unread" ? { markUnread: true } : {}),
          },
        });
        const failure = failedMessage(result, "Couldn't update those chats.");
        if (failure !== null) {
          setError(failure);
          return;
        }
      }
      setSelected(new Set());
    } catch {
      setError("Couldn't update those chats.");
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (row: ChatActionRow) => {
    setMenuRow(null);
    const result = await updateThreads({
      environmentId: native.environmentId,
      input: {
        threadIds: [ThreadId.make(row.link.threadId)],
        pinned: row.link.pinnedAt === undefined,
      },
    });
    const failure = failedMessage(result, "Couldn't update that chat.");
    if (failure !== null) setError(failure);
  };

  const archiveOne = async (row: ChatActionRow) => {
    setMenuRow(null);
    const result = await archiveThread({
      environmentId: native.environmentId,
      input: { threadId: ThreadId.make(row.link.threadId), archived: true },
    });
    const failure = failedMessage(result, "Couldn't archive this chat.");
    if (failure !== null) setError(failure);
  };

  const deleteOne = async (row: ChatActionRow) => {
    setMenuRow(null);
    const result = await deleteThread({
      environmentId: native.environmentId,
      input: { threadId: ThreadId.make(row.link.threadId) },
    });
    const failure = failedMessage(result, "Couldn't delete this chat.");
    if (failure !== null) setError(failure);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      {selecting ? (
        <View style={styles.header}>
          <Pressable
            onPress={() => setSelected(new Set())}
            accessibilityRole="button"
            style={styles.headerTextButton}
          >
            <Text style={styles.headerText}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle} accessibilityLiveRegion="polite">
            {`${selected.size} selected`}
          </Text>
          <Pressable
            onPress={() =>
              setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.link.threadId)))
            }
            accessibilityRole="button"
            style={styles.headerTextButton}
          >
            <Text style={styles.headerText}>{allSelected ? "Deselect all" : "Select all"}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.iconButton}
          >
            <IconChevronLeft size={24} color={tokens.text} strokeWidth={1.75} />
          </Pressable>
          <View style={styles.headerBody}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              All chats
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {bot?.name ?? "Bot"}
            </Text>
          </View>
          <Pressable
            onPress={() => setNewChatOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`New chat with ${bot?.name ?? "this bot"}`}
            style={[styles.iconButton, styles.newButton]}
          >
            <IconPlus size={22} color={tokens.primaryText} strokeWidth={2} />
          </Pressable>
        </View>
      )}

      {error !== null ? (
        <Pressable onPress={() => setError(null)} style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      ) : null}

      {list.error !== null && list.data === null ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Couldn't load your chats.</Text>
          <Pressable onPress={() => list.refresh()} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : list.data === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color={tokens.textSecondary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.link.threadId}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No chats here. Start one with the plus.</Text>
          }
          renderItem={({ item }) => {
            const checked = selected.has(item.link.threadId);
            const title = conversationChatTitle(item.shell.title) ?? "New chat";
            const preview =
              item.link.newestMessage == null || item.link.newestMessage.hidden === true
                ? ""
                : item.link.newestMessage.text;
            return (
              <Pressable
                onPress={() =>
                  selecting ? toggle(item.link.threadId) : onOpenChat(item.link.threadId)
                }
                onLongPress={() => {
                  if (!selecting) setSelected(new Set([item.link.threadId]));
                  else toggle(item.link.threadId);
                }}
                delayLongPress={350}
                accessibilityRole="button"
                accessibilityLabel={`${title}${item.unread ? ", unread" : ""}${item.link.pinnedAt !== undefined ? ", pinned" : ""}`}
                accessibilityState={selecting ? { selected: checked } : undefined}
                style={styles.row}
              >
                {selecting ? (
                  <View style={[styles.check, checked ? styles.checkOn : null]}>
                    {checked ? <Text style={styles.checkMark}>✓</Text> : null}
                  </View>
                ) : null}
                <View style={styles.rowBody}>
                  <View style={styles.rowTop}>
                    {item.link.pinnedAt !== undefined ? (
                      <IconPin size={13} color={tokens.textTertiary} strokeWidth={2} />
                    ) : null}
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {title}
                    </Text>
                    {item.unread ? <View style={styles.unreadDot} /> : null}
                    <Text style={styles.rowTime}>
                      {formatRelativeTime(
                        DateTime.toEpochMillis(item.link.lastActivityAt ?? item.link.createdAt),
                        now,
                      )}
                    </Text>
                  </View>
                  {preview.length > 0 ? (
                    <Text style={styles.rowPreview} numberOfLines={2}>
                      {preview}
                    </Text>
                  ) : null}
                </View>
                {!selecting ? (
                  <Pressable
                    onPress={() => setMenuRow(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Chat options for ${title}`}
                    style={styles.rowMenu}
                  >
                    <Text style={styles.rowMenuText}>•••</Text>
                  </Pressable>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}

      {selecting ? (
        <View style={[styles.actionBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Pressable
            onPress={() => void runBulk("archive")}
            disabled={busy}
            accessibilityRole="button"
            style={styles.actionBarButton}
          >
            <IconArchive size={18} color={tokens.text} strokeWidth={1.75} />
            <Text style={styles.actionBarText}>Archive</Text>
          </Pressable>
          <Pressable
            onPress={() => void runBulk("pin")}
            disabled={busy}
            accessibilityRole="button"
            style={styles.actionBarButton}
          >
            <Text style={styles.actionBarText}>
              {chosen.length > 0 && chosen.every((row) => row.link.pinnedAt) ? "Unpin" : "Pin"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void runBulk("unread")}
            disabled={busy}
            accessibilityRole="button"
            style={styles.actionBarButton}
          >
            <Text style={styles.actionBarText}>Mark unread</Text>
          </Pressable>
          <Pressable
            onPress={() => setSnoozeMany(true)}
            disabled={busy}
            accessibilityRole="button"
            style={styles.actionBarButton}
          >
            <Text style={styles.actionBarText}>Snooze</Text>
          </Pressable>
          <Pressable
            onPress={() => void runBulk("delete")}
            disabled={busy}
            accessibilityRole="button"
            style={[styles.actionBarButton, styles.actionBarEnd]}
          >
            <Text style={styles.actionBarDelete}>Delete</Text>
          </Pressable>
        </View>
      ) : null}

      <ChatActionsSheet
        native={native}
        chat={chat}
        row={menuRow}
        onClose={() => setMenuRow(null)}
        onRename={(row) => {
          setMenuRow(null);
          setRenameRow(row);
        }}
        onTogglePin={(row) => void togglePin(row)}
        onArchive={(row) => void archiveOne(row)}
        onDelete={(row) => void deleteOne(row)}
        onSnooze={(row) => {
          setMenuRow(null);
          setSnoozeRow(row);
        }}
      />
      <RenameChatSheet
        native={native}
        chat={chat}
        visible={renameRow !== null}
        threadId={renameRow?.link.threadId ?? ""}
        initialTitle={renameRow?.shell.title ?? ""}
        takenTitles={rows.filter((row) => row !== renameRow).map((row) => row.shell.title)}
        onClose={() => setRenameRow(null)}
        onSaved={() => setError(null)}
      />
      <SnoozeSheet
        native={native}
        visible={snoozeRow !== null}
        threadIds={snoozeRow === null ? [] : [snoozeRow.link.threadId]}
        onClose={() => setSnoozeRow(null)}
        onSnoozed={() => setError(null)}
        onError={setError}
      />
      <SnoozeSheet
        native={native}
        visible={snoozeMany}
        threadIds={chosen.map((row) => row.link.threadId)}
        onClose={() => setSnoozeMany(false)}
        onSnoozed={() => setSelected(new Set())}
        onError={setError}
      />
      {newChatOpen ? (
        <NewChatSheet
          native={native}
          visible
          botId={botId}
          botName={bot?.name ?? "Bot"}
          openChatTitles={rows.map((row) => row.shell.title)}
          onClose={() => setNewChatOpen(false)}
          onCreated={(threadId) => onOpenChat(threadId)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  header: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 4,
  },
  headerBody: { flex: 1, minWidth: 0 },
  headerTitle: { color: tokens.text, fontSize: 18, lineHeight: 23, fontWeight: "700", flex: 1 },
  headerSubtitle: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  headerTextButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  headerText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
  newButton: { backgroundColor: tokens.primary },
  errorBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    padding: 12,
  },
  errorText: { color: tokens.danger, fontSize: 14, lineHeight: 19 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { color: tokens.text, fontSize: 16, lineHeight: 21, fontWeight: "600", flexShrink: 1 },
  unreadDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: tokens.primary },
  rowTime: { marginLeft: "auto", color: tokens.textTertiary, fontSize: 13 },
  rowPreview: { color: tokens.textPreview, fontSize: 14, lineHeight: 19 },
  rowMenu: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  rowMenuText: { color: tokens.textSecondary, fontSize: 16, letterSpacing: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: tokens.textTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  checkMark: { color: tokens.primaryText, fontSize: 13, fontWeight: "700" },
  emptyText: { color: tokens.textSecondary, fontSize: 15, textAlign: "center", marginTop: 24 },
  empty: { padding: 24, alignItems: "center", gap: 12 },
  emptyTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  retry: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    justifyContent: "center",
  },
  retryText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
    paddingTop: 8,
    paddingHorizontal: 12,
    gap: 4,
  },
  actionBarButton: {
    minHeight: 44,
    paddingHorizontal: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  actionBarText: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  actionBarDelete: { color: tokens.danger, fontSize: 14, fontWeight: "600" },
  actionBarEnd: { marginLeft: "auto" },
});
