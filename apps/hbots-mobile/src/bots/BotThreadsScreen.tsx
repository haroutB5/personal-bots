import { useAtomValue } from "@effect/atom-react";
import { PersonalBotId, ThreadId, type PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { IconDots, IconNotebook, IconPencil, IconPlus } from "@tabler/icons-react-native";
import * as Option from "effect/Option";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  botActiveModelShortLabel,
  fallbackNoteLabel,
} from "@hbots/personal-client/bots/botModelLabel";
import { isThreadLive } from "@hbots/personal-client/bots/botSummaries";
import { bulkResultNotice, type ChatSection } from "@hbots/personal-client/bots/chatSelection";
import { isChatPinned } from "@hbots/personal-client/bots/chatState";
import type { BulkChatOptions } from "@hbots/personal-client/bots/bulkChatActions";
import { botThreadRows, type BotThreadRow } from "@hbots/personal-client/feed/botThreadRows";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "../shell/BotAvatar";
import { PersonalOfflineBanner } from "../shell/PersonalOfflineBanner";
import { tokens } from "../shell/tokens";
import { ChatActionsSheet, type ChatActionRow } from "../sheets/ChatActionsSheet";
import { NewChatSheet } from "../sheets/NewChatSheet";
import { RenameChatSheet } from "../sheets/RenameChatSheet";
import { SheetAction, SheetCancel, SheetShell } from "../sheets/SheetShell";
import { SnoozeSheet } from "../sheets/SnoozeSheet";
import {
  ARCHIVED_FAILED_TEXT,
  ARCHIVED_LOADING_TEXT,
  BOT_THREADS_GONE_MESSAGE,
  LOAD_FAILED_MESSAGE,
  NO_CHATS_HERE_TEXT,
  WRAPUP_FAILED_MESSAGE,
  activeEmptyText,
  archivedChatCount,
  archivedHeading,
  archivedLoad,
  bulkBarButtons,
  listMenuItems,
  newestRow,
  selectionAfterBulk,
  selectionView,
  snoozedHeading,
  startSelection,
  threadsScreenState,
  toggleAllThreads,
  toggleThread,
  turnsSettledKey,
  unreadThreadIds,
  workingCount,
  wrapupDisabled,
  type ThreadSelection,
} from "./botThreadsModel";
import {
  ActiveThreadRow,
  ArchivedThreadRow,
  SelectableThreadRow,
  SnoozedThreadRow,
  type RowAction,
} from "./ThreadRows";
import { useThreadActions } from "./useThreadActions";
import {
  useBulkNotice,
  useChatSeenState,
  useRefetchOnTurnsSettled,
  useSnoozeWakeClock,
} from "./useThreadsClocks";
import { useWrapupChat } from "./useWrapupChat";

interface SnoozeRequest {
  readonly ids: ReadonlyArray<string>;
  readonly bulk: boolean;
}

export function BotThreadsScreen({
  native,
  chat,
  botId,
  onBack,
  onOpenChat,
  onEditBot,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly botId: string;
  readonly onBack: () => void;
  readonly onOpenChat: (threadId: string) => void;
  readonly onEditBot: (botId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const connection = native.useConnectionState();
  const providers = native.useProviders();
  const chatSeen = useChatSeenState();
  const actions = useThreadActions(native);

  const lazyArchived = list.data?.archivedCounts !== undefined;
  const [archiveRequested, setArchiveRequested] = useState(false);
  const archivedLinks = native.bots.usePersonalArchivedLinks(
    environmentId,
    lazyArchived && archiveRequested ? { botId } : null,
    list.dataUpdatedAt,
  );
  const links = useMemo<ReadonlyArray<PersonalBotThread>>(() => {
    const open = list.data?.threads ?? [];
    if (!lazyArchived) return open;
    const openIds = new Set(open.map((link) => link.threadId));
    return [
      ...open,
      ...(archivedLinks.data?.threads.filter(
        (link) => link.archivedAt !== null && !openIds.has(link.threadId),
      ) ?? []),
    ];
  }, [archivedLinks.data, lazyArchived, list.data]);

  const shellState = useAtomValue(native.shell.stateValueAtom(environmentId));
  const baseShells = useMemo(
    () => native.shellsOf(Option.getOrNull(shellState.snapshot)),
    [native, shellState.snapshot],
  );
  const listLoaded = list.data !== null;
  const botShellsAtom = useMemo(
    () =>
      !listLoaded
        ? null
        : native.bots.personalBotsThreadShells({
            environmentId,
            input: { botId: PersonalBotId.make(botId) },
          }),
    [botId, environmentId, listLoaded, native],
  );
  const botShells = native.client.useEnvironmentQuery(botShellsAtom).data;
  const shells = useMemo<ReadonlyArray<EnvironmentThreadShell>>(() => {
    if (botShells === null) return baseShells;
    const known = new Set(baseShells.map((shell) => shell.id as string));
    return [
      ...baseShells,
      ...botShells.threads
        .filter((thread) => !known.has(thread.id))
        .map((thread) => ({ ...thread, environmentId })),
    ];
  }, [baseShells, botShells, environmentId]);

  const screen = threadsScreenState(botId, { bots: list.data?.bots ?? null, error: list.error });
  const bot = screen.kind === "ready" ? screen.bot : null;
  const wakeClock = useSnoozeWakeClock(list.data?.threads, list.refresh);
  const rows = useMemo(
    () =>
      bot === null
        ? { active: [], archived: [], snoozed: [] }
        : botThreadRows(bot.botId, links, shells, new Set(), wakeClock),
    [bot, links, shells, wakeClock],
  );
  const archivedCount = archivedChatCount(botId, list.data?.archivedCounts, rows.archived.length);
  const unread = useMemo(() => unreadThreadIds(rows.active, chatSeen), [chatSeen, rows.active]);
  useRefetchOnTurnsSettled(turnsSettledKey(rows.active), list.refresh);

  const newest = newestRow(rows.active);
  const wrapup = useWrapupChat(native, chat, bot, newest?.link.threadId ?? null);
  const [wrapupError, setWrapupError] = useState<string | null>(null);
  const offline = connection.phase !== "connected";
  const wrapupOff = wrapupDisabled({
    hasChat: newest !== null && wrapup.ready,
    offline,
    sending: wrapup.sending,
  });
  const onWrapup = async () => {
    if (newest === null || wrapupOff) return;
    setWrapupError(null);
    if (await wrapup.send()) onOpenChat(newest.link.threadId);
    else setWrapupError(WRAPUP_FAILED_MESSAGE);
  };

  const [selection, setSelection] = useState<ThreadSelection | null>(null);
  const [notice, setNotice] = useBulkNotice();
  const [actionError, setActionError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const [menuRow, setMenuRow] = useState<ChatActionRow | null>(null);
  const [renameRow, setRenameRow] = useState<ChatActionRow | null>(null);
  const [snoozeRequest, setSnoozeRequest] = useState<SnoozeRequest | null>(null);

  const view = selection === null ? null : selectionView(selection, rows);

  const enterSelect = useCallback(
    (section: ChatSection, first: string | null) => {
      setNotice(null);
      setActionError(null);
      if (section === "archived") setArchiveRequested(true);
      setSelection(startSelection(section, first));
    },
    [setNotice],
  );

  const runOne = async (
    action: "pin" | "unpin" | "snooze" | "wake",
    threadId: string,
    options?: BulkChatOptions,
  ) => {
    setActionError(null);
    const outcome = await actions.runBulk(action, [threadId], 0, options);
    if (outcome.status === "settled" && outcome.anyFailed) setActionError(outcome.notice);
  };

  const archiveOne = async (row: BotThreadRow, archived: boolean) => {
    setActionError(null);
    const outcome = await actions.setArchived(row.link.threadId, row.shell.title, archived);
    if (outcome.status === "failed") setActionError(outcome.message);
    else if (outcome.status === "done" && outcome.notice !== null) {
      setNotice({ text: outcome.notice, failed: false });
    }
  };

  const deleteOne = async (row: BotThreadRow) => {
    const outcome = await actions.deleteChat(
      row.link.threadId,
      row.shell.title,
      isThreadLive(row.shell),
    );
    if (outcome.status === "failed") setActionError(outcome.message);
    else if (outcome.status === "done") setActionError(null);
  };

  const onRowAction: RowAction = (key, row) => {
    switch (key) {
      case "pin":
      case "unpin":
        void runOne(key, row.link.threadId);
        return;
      case "snooze":
        setSnoozeRequest({ ids: [row.link.threadId], bulk: false });
        return;
      case "archive":
        void archiveOne(row, true);
        return;
      case "unarchive":
        void archiveOne(row, false);
        return;
      case "delete":
        void deleteOne(row);
        return;
      default: {
        const unreachable: never = key;
        return unreachable;
      }
    }
  };

  const onBulk = async (action: Parameters<typeof actions.runBulk>[0]) => {
    if (selection === null || view === null || view.chosen.length === 0 || bulkBusy) return;
    if (action === "snooze") {
      setSnoozeRequest({ ids: view.chosen, bulk: true });
      return;
    }
    const section = selection.section;
    setBulkBusy(true);
    const outcome = await actions.runBulk(
      action,
      view.chosen,
      workingCount(view.sectionRows, view.chosen),
    );
    setBulkBusy(false);
    if (outcome.status === "cancelled") return;
    setNotice({ text: outcome.notice, failed: outcome.anyFailed });
    setSelection(selectionAfterBulk(section, outcome.failedIds));
  };

  const openRow = (row: BotThreadRow) => onOpenChat(row.link.threadId);
  const rowTitles = (except: string | null) =>
    rows.active.filter((row) => row.link.threadId !== except).map((row) => row.shell.title);

  const noticeLine =
    notice === null ? null : (
      <Text
        style={[styles.noticeLine, notice.failed ? styles.noticeFailed : null]}
        accessibilityRole={notice.failed ? "alert" : undefined}
        accessibilityLiveRegion="polite"
      >
        {notice.text}
      </Text>
    );

  const archivedState = archivedLoad({
    lazy: lazyArchived,
    isSuccess: archivedLinks.isSuccess,
    error: archivedLinks.error,
  });
  const archivedStatus = <ArchivedStatus state={archivedState} onRetry={archivedLinks.refresh} />;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <PersonalOfflineBanner native={native} />
      {selection !== null && view !== null ? (
        <View style={styles.header}>
          <Pressable
            onPress={() => setSelection(null)}
            accessibilityRole="button"
            style={styles.textButton}
          >
            <Text style={styles.textButtonLabel}>Cancel</Text>
          </Pressable>
          <Text style={styles.selectTitle} accessibilityLiveRegion="polite">
            {view.countLabel}
          </Text>
          <Pressable
            onPress={() => setSelection(toggleAllThreads(selection, view.sectionIds))}
            disabled={view.sectionIds.length === 0}
            accessibilityRole="button"
            style={[styles.textButton, view.sectionIds.length === 0 ? styles.dim : null]}
          >
            <Text style={styles.textButtonLabel}>
              {view.everySelected ? "Deselect all" : "Select all"}
            </Text>
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
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          {bot === null ? (
            <Text style={styles.headerTitle}>Chats</Text>
          ) : (
            <>
              <BotAvatar
                shape={bot.avatarShape}
                color={bot.avatarColor}
                size={40}
                label={bot.name}
              />
              <View style={styles.headerBody}>
                <Text style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                  {bot.name}
                </Text>
                <ModelLine
                  label={botActiveModelShortLabel(bot, providers)}
                  note={fallbackNoteLabel(bot)}
                />
              </View>
              <Pressable
                onPress={() => onEditBot(bot.botId)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${bot.name}`}
                style={styles.iconButton}
              >
                <IconPencil size={20} color={tokens.text} strokeWidth={1.75} />
              </Pressable>
              <Pressable
                onPress={() => setListMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Chat list options"
                style={styles.iconButton}
              >
                <IconDots size={24} color={tokens.text} strokeWidth={1.75} />
              </Pressable>
            </>
          )}
        </View>
      )}

      {screen.kind === "loading" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={tokens.textSecondary} />
        </View>
      ) : screen.kind === "error" ? (
        <View style={styles.centered}>
          <Text style={styles.mutedText}>{LOAD_FAILED_MESSAGE}</Text>
          <Pressable onPress={list.refresh} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.textButtonLabel}>Try again</Text>
          </Pressable>
        </View>
      ) : screen.kind === "notFound" ? (
        <View style={styles.centered}>
          <Text style={styles.mutedText}>{BOT_THREADS_GONE_MESSAGE}</Text>
          <Pressable onPress={onBack} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.textButtonLabel}>Back</Text>
          </Pressable>
        </View>
      ) : selection !== null && view !== null ? (
        <>
          <ScrollView contentContainerStyle={styles.scroll}>
            {noticeLine}
            {selection.section === "archived" ? (
              <Text style={styles.sectionHeading}>{archivedHeading(archivedCount)}</Text>
            ) : null}
            {selection.section === "archived" && archivedState !== "ready" ? (
              archivedStatus
            ) : view.sectionRows.length === 0 ? (
              <Text style={styles.emptyText}>{NO_CHATS_HERE_TEXT}</Text>
            ) : (
              <View style={styles.list}>
                {view.sectionRows.map((row) => (
                  <SelectableThreadRow
                    key={row.link.threadId}
                    row={row}
                    now={wakeClock}
                    selected={selection.ids.has(row.link.threadId)}
                    unread={unread.has(row.link.threadId)}
                    onToggle={(toggled) =>
                      setSelection(toggleThread(selection, toggled.link.threadId))
                    }
                  />
                ))}
              </View>
            )}
          </ScrollView>
          <View style={[styles.bulkBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {bulkBarButtons(selection.section, view.allChosenPinned).map((button) => (
              <Pressable
                key={button.action}
                onPress={() => void onBulk(button.action)}
                disabled={view.chosen.length === 0 || bulkBusy}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: view.chosen.length === 0 || bulkBusy,
                  busy: bulkBusy,
                }}
                style={[
                  styles.bulkButton,
                  button.danger ? styles.bulkEnd : null,
                  view.chosen.length === 0 || bulkBusy ? styles.dim : null,
                ]}
              >
                <Text style={button.danger ? styles.bulkDelete : styles.bulkText}>
                  {button.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.buttons}>
            <Pressable
              onPress={() => setNewChatOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`New chat with ${bot?.name ?? "this bot"}`}
              style={[styles.bigButton, styles.bigPrimary]}
            >
              <IconPlus size={20} color={tokens.primaryText} strokeWidth={1.75} />
              <Text style={styles.bigPrimaryText}>New chat</Text>
            </Pressable>
            <Pressable
              onPress={() => void onWrapup()}
              disabled={wrapupOff}
              accessibilityRole="button"
              accessibilityState={{ disabled: wrapupOff, busy: wrapup.sending }}
              style={[styles.bigButton, styles.bigQuiet, wrapupOff ? styles.dim : null]}
            >
              <IconNotebook size={20} color={tokens.text} strokeWidth={1.75} />
              <Text style={styles.bigQuietText}>Wrapup</Text>
            </Pressable>
          </View>
          {wrapupError === null ? null : (
            <Text style={styles.errorLine} accessibilityRole="alert">
              {wrapupError}
            </Text>
          )}
          {actionError === null ? null : (
            <Text style={styles.errorLine} accessibilityRole="alert">
              {actionError}
            </Text>
          )}
          {noticeLine}

          {rows.active.length === 0 ? (
            <Text style={styles.emptyText}>
              {activeEmptyText(screen.bot.name, rows.snoozed.length)}
            </Text>
          ) : (
            <View style={styles.list}>
              {rows.active.map((row) => (
                <ActiveThreadRow
                  key={row.link.threadId}
                  row={row}
                  now={wakeClock}
                  unread={unread.has(row.link.threadId)}
                  onOpen={openRow}
                  onSelect={(held) => enterSelect("active", held.link.threadId)}
                  onAction={onRowAction}
                  onMenu={setMenuRow}
                />
              ))}
            </View>
          )}

          {rows.snoozed.length > 0 ? (
            <View style={styles.section}>
              <SectionToggle
                label={snoozedHeading(rows.snoozed.length)}
                open={snoozedOpen}
                onPress={() => setSnoozedOpen((open) => !open)}
              />
              {snoozedOpen ? (
                <View style={styles.list}>
                  {rows.snoozed.map((row) => (
                    <SnoozedThreadRow
                      key={row.link.threadId}
                      row={row}
                      now={wakeClock}
                      onOpen={openRow}
                      onWake={(woken) => void runOne("wake", woken.link.threadId)}
                      onAction={onRowAction}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {archivedCount > 0 ? (
            <View style={styles.section}>
              <SectionToggle
                label={archivedHeading(archivedCount)}
                open={archivedOpen}
                onPress={() => {
                  if (!archivedOpen) setArchiveRequested(true);
                  setArchivedOpen((open) => !open);
                }}
              />
              {archivedOpen ? (
                <>
                  {archivedState === "ready" ? null : archivedStatus}
                  <View style={styles.list}>
                    {rows.archived.map((row) => (
                      <ArchivedThreadRow
                        key={row.link.threadId}
                        row={row}
                        now={wakeClock}
                        onOpen={openRow}
                        onSelect={(held) => enterSelect("archived", held.link.threadId)}
                        onAction={onRowAction}
                      />
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      )}

      <SheetShell
        visible={listMenuOpen}
        title="Chat list options"
        onClose={() => setListMenuOpen(false)}
      >
        {listMenuItems(rows.active.length, archivedCount).map((item) => (
          <SheetAction
            key={item.section}
            label={item.label}
            disabled={item.disabled}
            onPress={() => {
              setListMenuOpen(false);
              enterSelect(item.section, null);
            }}
          />
        ))}
        <SheetCancel onPress={() => setListMenuOpen(false)} />
      </SheetShell>
      <ChatActionsSheet
        native={native}
        chat={chat}
        row={menuRow}
        onClose={() => setMenuRow(null)}
        onRename={(row) => {
          setMenuRow(null);
          setRenameRow(row);
        }}
        onTogglePin={(row) => {
          setMenuRow(null);
          void runOne(isChatPinned(row.link) ? "unpin" : "pin", row.link.threadId);
        }}
        onArchive={(row) => {
          setMenuRow(null);
          void archiveOne({ ...row, updatedMs: 0 }, row.shell.archivedAt === null);
        }}
        onDelete={(row) => {
          setMenuRow(null);
          void deleteOne({ ...row, updatedMs: 0 });
        }}
        onSnooze={(row) => {
          setMenuRow(null);
          setSnoozeRequest({ ids: [row.link.threadId], bulk: false });
        }}
      />
      <RenameChatSheet
        native={native}
        chat={chat}
        visible={renameRow !== null}
        threadId={renameRow?.link.threadId ?? ""}
        initialTitle={renameRow?.shell.title ?? ""}
        takenTitles={rowTitles(renameRow?.link.threadId ?? null)}
        onClose={() => setRenameRow(null)}
        onSaved={() => setActionError(null)}
      />
      <SnoozeSheet
        native={native}
        visible={snoozeRequest !== null}
        threadIds={snoozeRequest?.ids ?? []}
        onClose={() => setSnoozeRequest(null)}
        onSnoozed={() => {
          if (snoozeRequest === null) return;
          setActionError(null);
          if (!snoozeRequest.bulk) return;
          setNotice({
            text: bulkResultNotice("snooze", {
              done: snoozeRequest.ids.map((id) => ThreadId.make(id)),
              failed: [],
            }).text,
            failed: false,
          });
          setSelection(null);
        }}
        onError={(message) => {
          if (snoozeRequest?.bulk === true) setNotice({ text: message, failed: true });
          else setActionError(message);
        }}
      />
      {newChatOpen && bot !== null ? (
        <NewChatSheet
          native={native}
          visible
          botId={botId}
          botName={bot.name}
          openChatTitles={rowTitles(null)}
          onClose={() => setNewChatOpen(false)}
          onCreated={(threadId) => onOpenChat(threadId)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function ModelLine({
  label,
  note,
}: {
  readonly label: string | null;
  readonly note: string | null;
}) {
  if (label === null) return null;
  return (
    <Text
      style={styles.modelLine}
      numberOfLines={1}
      maxFontSizeMultiplier={1.3}
      accessibilityLabel={note === null ? label : `${label} (${note})`}
    >
      {label}
    </Text>
  );
}

function SectionToggle({
  label,
  open,
  onPress,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={styles.sectionToggle}
    >
      <Text style={styles.sectionHeading}>{label}</Text>
      <Text style={styles.sectionChevron}>{open ? "▾" : "▸"}</Text>
    </Pressable>
  );
}

function ArchivedStatus({
  state,
  onRetry,
}: {
  readonly state: "ready" | "loading" | "error";
  readonly onRetry: () => void;
}) {
  switch (state) {
    case "ready":
      return null;
    case "loading":
      return <Text style={styles.emptyText}>{ARCHIVED_LOADING_TEXT}</Text>;
    case "error":
      return (
        <View style={styles.centeredInline}>
          <Text style={styles.mutedText}>{ARCHIVED_FAILED_TEXT}</Text>
          <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.textButtonLabel}>Try again</Text>
          </Pressable>
        </View>
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  header: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 8,
  },
  headerBody: { flex: 1, minWidth: 0 },
  headerTitle: { flex: 1, color: tokens.text, fontSize: 19, lineHeight: 24, fontWeight: "700" },
  modelLine: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  selectTitle: {
    flex: 1,
    color: tokens.text,
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
  },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backGlyph: { color: tokens.text, fontSize: 32, lineHeight: 34 },
  textButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  textButtonLabel: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  dim: { opacity: 0.4 },
  scroll: { paddingHorizontal: 20, paddingBottom: 32 },
  buttons: { marginTop: 12, gap: 12 },
  bigButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
  },
  bigPrimary: { backgroundColor: tokens.primary },
  bigPrimaryText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  bigQuiet: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
  },
  bigQuietText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  errorLine: { marginTop: 8, textAlign: "center", color: tokens.error, fontSize: 14 },
  noticeLine: { marginTop: 12, textAlign: "center", color: tokens.textSecondary, fontSize: 14 },
  noticeFailed: { color: tokens.error },
  list: {
    marginTop: 16,
    marginHorizontal: -20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  section: { marginTop: 24 },
  sectionToggle: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  sectionHeading: { color: tokens.textSecondary, fontSize: 15, fontWeight: "500" },
  sectionChevron: { color: tokens.textSecondary, fontSize: 13 },
  emptyText: { marginTop: 24, textAlign: "center", color: tokens.textSecondary, fontSize: 15 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  centeredInline: { alignItems: "center", padding: 16, gap: 12 },
  mutedText: { color: tokens.textSecondary, fontSize: 15, textAlign: "center" },
  retry: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    justifyContent: "center",
  },
  bulkBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    backgroundColor: tokens.bg,
    paddingTop: 8,
    paddingHorizontal: 12,
    gap: 4,
  },
  bulkButton: { minHeight: 44, paddingHorizontal: 10, justifyContent: "center" },
  bulkEnd: { marginLeft: "auto" },
  bulkText: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  bulkDelete: { color: tokens.danger, fontSize: 14, fontWeight: "600" },
});
