import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  ThreadId,
  WRAPUP_CHAT_PROMPT,
  botEffectiveModelSelection,
  type PersonalBotNotificationMute,
  type PersonalReplyQuote,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { requestOlderThreadTurns } from "@t3tools/client-runtime/state/threads";
import {
  IconBellOff,
  IconChevronLeft,
  IconDeviceLaptop,
  IconDots,
  IconSearch,
  IconX,
} from "@tabler/icons-react-native";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  newOutboxId,
  outboxCommandId,
  useOutboxRows,
  removeOutboxEntry,
  retryOutboxEntry,
} from "@hbots/personal-client/composer/outbox";
import { hidesBotPreviews } from "@hbots/personal-client/conversation/previewPrivacy";
import {
  buildChatSettingsTarget,
  chatSettingsHeader,
  chatSettingsRows,
  type ChatSettingsRowId,
} from "@hbots/personal-client/bots/chatSettingsModel";
import { DEFAULT_TOKEN_USAGE_WINDOW } from "@hbots/personal-client/usage/tokenUsagePresentation";
import { readChatsSnapshot } from "@hbots/personal-client/bots/chatsSnapshot";
import { buildChatFeed } from "@hbots/personal-client/feed/chatFeed";
import { deriveLatestMessageReadStatus } from "@hbots/personal-client/feed/messageReadStatus";
import { sharedPreferencesFromProfile } from "@hbots/personal-client/settings/profilePreferences";
import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveChatCwd } from "@hbots/personal-client/feed/chatCwd";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import { useThreadDetailView, useThreadRef } from "../chat/chatEnvironment";
import { Composer } from "../chat/Composer";
import { buildChatChips, chatHeaderModel, findChatBot } from "../chat/chatModel";
import { chatKeyboardLayout } from "../chat/chatKeyboardLayout";
import { lastTurnStartMessageId } from "../chat/cards/contextTurn";
import { RulesUsageCard } from "../chat/cards/RulesUsageCard";
import { MessageList } from "../chat/MessageList";
import type { MessageListHandle } from "../chat/MessageList";
import { useChatCards } from "../chat/useChatCards";
import { useNow } from "../chat/useNow";
import { useKeyboardInset } from "../platform/useKeyboardInset";
import { providerWaitState } from "@hbots/personal-client/conversation/conversationModel";
import type { PendingOutgoingMessage } from "@hbots/personal-client/feed/types";
import { BotAvatar } from "../shell/BotAvatar";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { BotUsageSheet } from "../sheets/BotUsageSheet";
import { ChatMenuSheet } from "../sheets/ChatMenuSheet";
import { ChatSettingsSheet } from "../sheets/ChatSettingsSheet";
import { ContextUsedSheet } from "../sheets/ContextUsedSheet";
import { RoutinesSheet } from "../sheets/RoutinesSheet";
import { FilePreviewSheet } from "../sheets/FilePreviewSheet";
import { MessageMenuSheet, type MessageMenuTarget } from "../sheets/MessageMenuSheet";
import { NewChatSheet } from "../sheets/NewChatSheet";
import { RenameChatSheet } from "../sheets/RenameChatSheet";
import { SnoozeSheet } from "../sheets/SnoozeSheet";

const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 250;

function failureText(result: { readonly _tag: string }, fallback: string): string | null {
  if (result._tag === "Success") return null;
  const cause = squashAtomCommandFailure(result as never);
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export function ChatScreen({
  native,
  chat,
  botId,
  threadId,
  onBack,
  onOpenChat,
  onOpenChats,
  onOpenBot,
  onOpenRoutine,
  onOpenComputer,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly botId: string;
  readonly threadId: string;
  readonly onBack: () => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onOpenChats: (botId: string) => void;
  readonly onOpenBot: (botId: string) => void;
  readonly onOpenRoutine: (routineId: string) => void;
  readonly onOpenComputer: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const profile = native.bots.usePersonalProfile(environmentId);
  const providers = native.useProviders();
  const connection = native.useConnectionState();
  const ref = useThreadRef(environmentId, threadId);
  const view = useThreadDetailView(chat, ref);
  const retryThread = useAtomRefresh(chat.states.stateAtom(environmentId, ThreadId.make(threadId)));
  const shellState = useAtomValue(native.shell.stateValueAtom(environmentId));
  const shells = useMemo(
    () => native.shellsOf(Option.getOrNull(shellState.snapshot)),
    [native, shellState.snapshot],
  );
  const now = useNow();
  const queued = useOutboxRows(threadId);
  const [pending, setPending] = useState<ReadonlyArray<PendingOutgoingMessage>>([]);
  const [replyTo, setReplyTo] = useState<PersonalReplyQuote | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [usageWindow, setUsageWindow] = useState(DEFAULT_TOKEN_USAGE_WINDOW);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenuTarget | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchRows, setSearchRows] = useState<
    ReadonlyArray<{ threadId: string; snippet: string; title: string }>
  >([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const prewarmed = useRef(false);
  const openedAt = useRef(performance.now());
  const openLogged = useRef(false);
  const keyboard = useKeyboardInset();
  const [composerHeight, setComposerHeight] = useState(0);
  const [dockHeight, setDockHeight] = useState(36);
  const [listHeight, setListHeight] = useState(0);
  const chatLayout = chatKeyboardLayout({
    bodyHeight: keyboard.frameHeight,
    keyboardInset: keyboard.padding,
    keyboardOpen: keyboard.open,
    composerHeight,
    dockHeight,
    listHeight,
  });
  const messageListControl = useRef<MessageListHandle | null>(null);
  const revealCard = (itemId: string) => messageListControl.current?.scrollToCard(itemId);

  const interrupt = native.client.useAtomCommand(chat.thread.interruptTurn, {
    reportFailure: false,
  });
  const updateThreads = native.client.useAtomCommand(native.bots.personalBotUpdateThreads, {
    reportFailure: false,
  });
  const archiveThread = native.client.useAtomCommand(native.bots.personalBotArchiveThread, {
    reportFailure: false,
  });
  const deleteThread = native.client.useAtomCommand(native.bots.personalBotDeleteThread, {
    reportFailure: false,
  });
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const prewarm = native.client.useAtomCommand(native.bots.personalBotsPrewarmThread, {
    reportFailure: false,
  });
  const reportViewing = native.client.useAtomCommand(native.bots.personalPushReportViewing, {
    reportFailure: false,
  });
  const searchMessages = native.client.useAtomCommand(native.bots.personalBotsSearchMessages, {
    reportFailure: false,
  });
  const startTurn = native.client.useAtomCommand(chat.thread.startTurn, {
    reportFailure: false,
  });
  const tokenUsage = native.bots.usePersonalTokenUsage(environmentId);

  const links = list.data?.threads ?? [];
  const record = useMemo(
    () => findChatBot(list.data?.bots ?? [], links, shells, botId, threadId),
    [botId, links, list.data?.bots, shells, threadId],
  );
  const thread = view.thread;
  const projects = useMemo(
    () => Option.getOrNull(shellState.snapshot)?.projects ?? [],
    [shellState.snapshot],
  );
  const chatCwd = resolveChatCwd(thread, projects);
  const shell = record?.shell ?? null;
  const archived = shell?.archivedAt != null;
  const link = links.find((candidate) => candidate.threadId === threadId) ?? null;

  const showToolSteps = sharedPreferencesFromProfile(profile.data).showToolSteps;
  const items = useMemo(
    () =>
      thread === null
        ? []
        : buildChatFeed({
            messages: thread.messages,
            proposedPlans: thread.proposedPlans,
            activities: thread.activities,
            showToolSteps,
          }),
    [thread, showToolSteps],
  );
  const cards = useChatCards({
    native,
    chat,
    environmentId,
    threadId,
    activities: thread?.activities ?? [],
    items,
    bots: list.data?.bots ?? [],
    botName: record?.bot?.name ?? "Bot",
    providers,
    nowMs: now,
    onOpenChat,
    onRevealCard: revealCard,
    cardMaxHeight: chatLayout.keyboardOpen ? chatLayout.cardMaxHeight : null,
  });
  const latestMessageStatus = useMemo(
    () =>
      thread === null
        ? null
        : deriveLatestMessageReadStatus({
            items: cards.items,
            activities: thread.activities,
            busy: thread.session?.status === "running" || thread.session?.status === "starting",
            latestTurn: thread.latestTurn,
          }),
    [cards.items, thread],
  );
  const usedTokens = useMemo(() => {
    if (thread === null) return null;
    for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
      const activity = thread.activities[index];
      if (activity?.kind !== "context-window.updated") continue;
      const payload = activity.payload as { readonly usedTokens?: unknown } | null;
      if (typeof payload?.usedTokens === "number") return payload.usedTokens;
    }
    return null;
  }, [thread]);
  const providerWait = providerWaitState(thread?.session ?? null) !== null;
  const cachedBot = useMemo(
    () =>
      readChatsSnapshot(native.client.ports.kv, environmentId)?.rows.find(
        (row) => row.botId === botId,
      ) ?? null,
    [botId, environmentId, native.client.ports.kv],
  );
  const header = chatHeaderModel({
    bot: record?.bot ?? null,
    shell,
    title: thread?.title ?? shell?.title ?? null,
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
    activities: thread?.activities ?? [],
    providers,
    usedTokens,
    nowMs: now,
    fallbackBotName: cachedBot?.name ?? null,
  });
  const chips = useMemo(
    () =>
      buildChatChips({
        botId,
        currentThreadId: threadId,
        links,
        shells,
      }),
    [botId, links, shells, threadId],
  );
  const running = thread?.session?.status === "running" || thread?.session?.status === "starting";
  const settingsTarget = useMemo(() => {
    if (shell === null) return null;
    const bot = record?.bot ?? null;
    return buildChatSettingsTarget({
      threadId,
      currentThreadId: threadId,
      kind: archived ? "archived" : "chat",
      link: link ?? syntheticLink(botId, threadId, shell),
      shell,
      waitingLabel: null,
      unread: false,
      hidePreviews: bot !== null && hidesBotPreviews(bot),
      openChatBusy: running,
      nowMs: now,
    });
  }, [archived, botId, link, now, record?.bot, running, shell, threadId]);
  const settingsHeader = settingsTarget === null ? null : chatSettingsHeader(settingsTarget, now);
  const settingsGroups =
    settingsTarget === null
      ? []
      : chatSettingsRows(settingsTarget, {
          turnsUnavailable: false,
          wrapupSending: false,
          threadLoading: thread === null,
          nowMs: now,
        });
  const contextMessageId = useMemo(() => lastTurnStartMessageId(cards.items), [cards.items]);

  useEffect(() => {
    if (thread === null || openLogged.current) return;
    openLogged.current = true;
    requestAnimationFrame(() => {
      console.info(`[perf] chat-open-ms ${Math.round(performance.now() - openedAt.current)}`);
    });
  }, [thread]);

  useEffect(() => {
    if (prewarmed.current || thread !== null) return;
    prewarmed.current = true;
    const frame = requestAnimationFrame(() => {
      void prewarm({ environmentId, input: { threadId: ThreadId.make(threadId) } });
    });
    return () => cancelAnimationFrame(frame);
  }, [environmentId, prewarm, thread, threadId]);

  useEffect(() => {
    if (connection.phase !== "connected") return;
    const send = (viewing: boolean) => {
      void reportViewing({
        environmentId,
        input: { threadId: viewing ? ThreadId.make(threadId) : null },
      });
    };
    send(true);
    const timer = setInterval(() => send(true), 10_000);
    return () => {
      clearInterval(timer);
      send(false);
    };
  }, [connection.phase, environmentId, reportViewing, threadId]);

  useEffect(() => {
    if (!searchOpen) {
      setSearch("");
      setSearchRows([]);
      return;
    }
    const text = search.trim();
    if (text.length < SEARCH_MIN_CHARS) {
      setSearchRows([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setSearchBusy(true);
      void searchMessages({ environmentId, input: { query: text } })
        .then((result) => {
          if (!live) return;
          if (result._tag !== "Success") return;
          setSearchRows(
            result.value.hits.map((hit) => ({
              threadId: hit.threadId,
              snippet: hit.snippet,
              title: shells.find((candidate) => candidate.id === hit.threadId)?.title ?? "Chat",
            })),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          if (live) setSearchBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      setSearchBusy(false);
    };
  }, [environmentId, search, searchMessages, searchOpen, shells]);

  const togglePin = async () => {
    setSettingsOpen(false);
    const result = await updateThreads({
      environmentId,
      input: {
        threadIds: [ThreadId.make(threadId)],
        pinned: link?.pinnedAt === undefined,
      },
    });
    setActionError(failureText(result, "Couldn't update this chat."));
  };

  const archive = async () => {
    setSettingsOpen(false);
    const result = await archiveThread({
      environmentId,
      input: { threadId: ThreadId.make(threadId), archived: !archived },
    });
    setActionError(failureText(result, "Couldn't archive this chat."));
  };

  const remove = async () => {
    setSettingsOpen(false);
    const ok = await native.client.ports.confirm.confirm({
      title: "Delete this chat?",
      body: "The chat and its messages are removed for good.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const result = await deleteThread({
      environmentId,
      input: { threadId: ThreadId.make(threadId) },
    });
    if (result._tag === "Success") {
      onBack();
      return;
    }
    setActionError(failureText(result, "Couldn't delete this chat."));
  };

  const setMute = async (mute: PersonalBotNotificationMute) => {
    setMenuOpen(false);
    if (record?.bot == null) return;
    const result = await updateBot({
      environmentId,
      input: { botId: record.bot.botId, notificationsMute: mute },
    });
    setActionError(failureText(result, "Couldn't change notifications."));
  };

  const stop = async () => {
    setMenuOpen(false);
    const result = await interrupt({
      environmentId,
      input: { threadId: ThreadId.make(threadId) },
    });
    setActionError(failureText(result, "Couldn't stop this turn."));
  };

  const wrapup = async () => {
    setSettingsOpen(false);
    if (record?.bot == null || thread === null) return;
    const messageId = newOutboxId();
    const result = await startTurn({
      environmentId,
      input: {
        commandId: CommandId.make(outboxCommandId(messageId)),
        threadId: ThreadId.make(threadId),
        message: {
          messageId: MessageId.make(messageId),
          role: "user",
          text: WRAPUP_CHAT_PROMPT,
          attachments: [],
        },
        modelSelection: botEffectiveModelSelection(record.bot),
        titleSeed: thread.title,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      },
    });
    setActionError(failureText(result, "Couldn't start the wrapup. Try again."));
  };

  const onSettingsRow = (id: ChatSettingsRowId) => {
    switch (id) {
      case "pin":
      case "unpin":
        void togglePin();
        return;
      case "snooze":
        setSettingsOpen(false);
        setSnoozeOpen(true);
        return;
      case "wake":
        setSettingsOpen(false);
        void updateThreads({
          environmentId,
          input: {
            threadIds: [ThreadId.make(threadId)],
            snoozedUntil: null,
          },
        });
        return;
      case "markUnread":
        setSettingsOpen(false);
        void updateThreads({
          environmentId,
          input: {
            threadIds: [ThreadId.make(threadId)],
            markUnread: true,
          },
        });
        return;
      case "rename":
        setSettingsOpen(false);
        setRenameOpen(true);
        return;
      case "wrapup":
        void wrapup();
        return;
      case "archive":
      case "unarchive":
        void archive();
        return;
      case "delete":
        void remove();
        return;
    }
  };

  const loadEarlier = () => {
    requestOlderThreadTurns(environmentId, ThreadId.make(threadId));
  };
  const page = Option.getOrNull(view.state.page);
  const loadEarlierAvailable = page?.hasMore === true;

  if (thread === null && view.status === "deleted") {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <ChatHeader title="Chat" subtitle={null} onBack={onBack} onMenu={null} onSearch={null} />
        <View style={styles.center}>
          <Text style={styles.centerText}>This chat no longer exists.</Text>
          <Pressable onPress={onBack} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.retryText}>Back to Bots</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {searchOpen ? (
        <View style={styles.searchHeader}>
          <View style={styles.searchBox}>
            <IconSearch size={17} color={tokens.textSecondary} strokeWidth={1.75} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              autoFocus
              placeholder="Search this bot's chats"
              placeholderTextColor={tokens.textSecondary}
              accessibilityLabel="Search messages"
              style={styles.searchInput}
            />
            {searchBusy ? <ActivityIndicator size="small" color={tokens.textSecondary} /> : null}
            <Pressable
              onPress={() => setSearchOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close search"
              style={styles.iconButton}
            >
              <IconX size={20} color={tokens.text} strokeWidth={1.75} />
            </Pressable>
          </View>
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
          {record?.bot != null || cachedBot !== null ? (
            <Pressable
              onPress={() => onOpenBot(botId)}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${header.botName}`}
              style={styles.headerIdentity}
            >
              <BotAvatar
                shape={record?.bot?.avatarShape ?? cachedBot?.avatarShape ?? "blob"}
                color={record?.bot?.avatarColor ?? cachedBot?.avatarColor ?? tokens.primary}
                size={48}
                label={header.botName}
              />
              <View style={styles.headerText}>
                <View style={styles.headerTitleRow}>
                  <Text style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                    {header.botName}
                  </Text>
                  {header.muted ? (
                    <IconBellOff size={15} color={tokens.textSecondary} strokeWidth={2} />
                  ) : null}
                  <Text
                    style={styles.titleChip}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.3}
                    accessibilityLabel={`Chat: ${header.chatTitle}`}
                  >
                    {header.chatTitle}
                  </Text>
                  {header.contextBadge !== null ? (
                    <Text style={styles.contextBadge}>{header.contextBadge}</Text>
                  ) : null}
                </View>
                {thread !== null ? (
                  <View style={styles.subtitleRow}>
                    <View style={[styles.stateDot, stateDotStyle(header.state)]} />
                    {header.state === "idle" && header.modelLabel !== null ? null : (
                      <Text style={styles.subtitle} numberOfLines={1}>
                        {header.stateLabel}
                      </Text>
                    )}
                    {header.modelLabel !== null ? (
                      <Text style={styles.modelLabel} numberOfLines={1}>
                        {header.state === "idle" ? header.modelLabel : ` · ${header.modelLabel}`}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </Pressable>
          ) : (
            <View style={styles.headerText}>
              <Text style={styles.headerTitle}>{thread?.title ?? "Chat"}</Text>
            </View>
          )}

          <Pressable
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Chat options"
            style={styles.iconButton}
          >
            <IconDots size={22} color={tokens.text} strokeWidth={1.75} />
          </Pressable>
        </View>
      )}

      {!searchOpen && chips.length >= 2 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: 134, y: 0 }}
          contentContainerStyle={styles.chips}
          style={styles.chipScroll}
        >
          {chips.map((chip) => (
            <Pressable
              key={chip.threadId}
              onPress={() => {
                if (!chip.current) onOpenChat(botId, chip.threadId);
              }}
              onLongPress={() => setSettingsOpen(true)}
              delayLongPress={350}
              accessibilityRole="tab"
              accessibilityState={{ selected: chip.current }}
              style={[styles.chip, chip.current ? styles.chipCurrent : null]}
            >
              {chip.unread && !chip.current ? (
                <View style={[styles.chipDot, styles.chipUnreadDot]} />
              ) : null}
              {chip.state !== "idle" && !chip.current ? (
                <View style={[styles.chipDot, stateDotStyle(chip.state)]} />
              ) : null}
              <Text
                style={[styles.chipText, chip.current ? styles.chipTextCurrent : null]}
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
              >
                {chip.text}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.body, { paddingBottom: keyboard.padding }]} onLayout={keyboard.onLayout}>
        {searchOpen ? (
          <ScrollView style={styles.searchResults} keyboardShouldPersistTaps="handled">
            {searchRows.length === 0 ? (
              <Text style={styles.searchEmpty}>
                {search.trim().length < SEARCH_MIN_CHARS
                  ? "Type at least two letters."
                  : searchBusy
                    ? "Searching…"
                    : "No messages match."}
              </Text>
            ) : (
              searchRows.map((row) => (
                <Pressable
                  key={`${row.threadId}:${row.snippet}`}
                  onPress={() => {
                    setSearchOpen(false);
                    onOpenChat(botId, row.threadId);
                  }}
                  accessibilityRole="button"
                  style={styles.searchRow}
                >
                  <Text style={styles.searchTitle} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text style={styles.searchSnippet} numberOfLines={2}>
                    {row.snippet}
                  </Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        ) : actionError !== null ? (
          <Pressable
            onPress={() => setActionError(null)}
            accessibilityRole="alert"
            style={styles.errorBox}
          >
            <Text style={styles.errorText}>{actionError}</Text>
          </Pressable>
        ) : null}

        {thread === null ? (
          <View style={styles.center}>
            {view.status === "empty" && view.error !== null ? (
              <>
                <Text style={styles.centerText}>Couldn't load this chat.</Text>
                <Pressable onPress={retryThread} accessibilityRole="button" style={styles.retry}>
                  <Text style={styles.retryText}>Try again</Text>
                </Pressable>
              </>
            ) : (
              <>
                <ActivityIndicator color={tokens.textSecondary} />
                <Text style={styles.centerText}>Loading chat</Text>
              </>
            )}
          </View>
        ) : (
          <>
            {cards.rulesUsage === null ? null : <RulesUsageCard usage={cards.rulesUsage} />}
            <MessageList
              native={native}
              chat={chat}
              cardContext={cards.context}
              items={cards.items}
              pending={pending}
              queued={queued}
              botName={header.botName}
              currentUserId="You"
              activities={thread.activities}
              latestTurn={thread.latestTurn}
              busy={running}
              latestMessageStatus={latestMessageStatus}
              onReply={(quote) => setReplyTo(quote)}
              onMessageMenu={setMessageMenu}
              onOpenFile={(path) => setFilePath(path)}
              onOpenLink={(url) => {
                void Linking.openURL(url).catch(() => setActionError("Couldn't open that link."));
              }}
              onCancelQueued={(id) => removeOutboxEntry(id)}
              onRetryQueued={(id) => {
                retryOutboxEntry(id);
                // Retry means now. A socket waiting out its backoff would
                // otherwise turn the tap into another 20 s of "Sending…".
                if (!native.readConnection().connected) native.retry();
              }}
              onLoadEarlier={loadEarlierAvailable ? loadEarlier : null}
              loadEarlierBusy={page?.loadingOlder === true}
              listControl={messageListControl}
              onHeightChange={setListHeight}
              keyboardInset={keyboard.padding}
            />
            {archived ? (
              <View style={[styles.archiveBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
                <Text style={styles.archiveText}>Archived · Unarchive to send messages again.</Text>
                <Pressable onPress={() => void archive()} accessibilityRole="button">
                  <Text style={styles.archiveAction}>Unarchive</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {chatLayout.dockVisible ? (
                  <Pressable
                    onPress={onOpenComputer}
                    onLayout={(event) => setDockHeight(event.nativeEvent.layout.height)}
                    accessibilityRole="button"
                    accessibilityLabel="Computer"
                    style={styles.computerDock}
                  >
                    <IconDeviceLaptop size={16} color={tokens.textSecondary} strokeWidth={1.75} />
                    <Text style={styles.computerDockText}>Computer</Text>
                  </Pressable>
                ) : null}
                <View
                  style={{ paddingBottom: Math.max(insets.bottom, 8) }}
                  onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
                >
                  <Composer
                    native={native}
                    chat={chat}
                    thread={thread}
                    threadId={threadId}
                    bot={record?.bot ?? null}
                    botName={header.botName}
                    working={running}
                    replyTo={replyTo}
                    onClearReply={() => setReplyTo(null)}
                    onPendingChange={setPending}
                    onSendError={setActionError}
                    onInterrupt={async () => {
                      const result = await interrupt({
                        environmentId,
                        input: { threadId: ThreadId.make(threadId) },
                      });
                      setActionError(failureText(result, "Couldn't stop this turn."));
                    }}
                    onSent={() => undefined}
                  />
                </View>
              </>
            )}
          </>
        )}
      </View>

      <ChatMenuSheet
        visible={menuOpen}
        bot={record?.bot ?? null}
        running={running}
        providerWait={providerWait}
        nowMs={now}
        onClose={() => setMenuOpen(false)}
        onStop={() => void stop()}
        onSwitchModel={() => {
          setMenuOpen(false);
          onOpenBot(botId);
        }}
        onChatSettings={() => {
          setMenuOpen(false);
          setSettingsOpen(true);
        }}
        onSearch={() => {
          setMenuOpen(false);
          setSearchOpen(true);
        }}
        onCall={() => {
          setMenuOpen(false);
          setActionError("Voice calls arrive with the voice update.");
        }}
        onNewChat={() => {
          setMenuOpen(false);
          setNewChatOpen(true);
        }}
        onAllChats={() => {
          setMenuOpen(false);
          onOpenChats(botId);
        }}
        onMute={(mute) => void setMute(mute)}
        onTokenUsage={() => {
          setMenuOpen(false);
          setUsageOpen(true);
        }}
        onContextUsed={() => {
          setMenuOpen(false);
          setContextOpen(true);
        }}
        onRoutines={() => {
          setMenuOpen(false);
          setRoutinesOpen(true);
        }}
      />
      <ChatSettingsSheet
        visible={settingsOpen}
        header={settingsHeader}
        groups={settingsGroups}
        onClose={() => setSettingsOpen(false)}
        onSelect={onSettingsRow}
      />
      <BotUsageSheet
        visible={usageOpen}
        bot={record?.bot ?? null}
        usage={tokenUsage.data}
        windowId={usageWindow}
        onWindowChange={setUsageWindow}
        onClose={() => setUsageOpen(false)}
        onOpenChat={() => {
          setUsageOpen(false);
          onOpenChats(botId);
        }}
      />
      <ContextUsedSheet
        native={native}
        visible={contextOpen}
        threadId={threadId}
        messageId={contextMessageId}
        onClose={() => setContextOpen(false)}
      />
      <RoutinesSheet
        native={native}
        visible={routinesOpen}
        botId={botId}
        botName={header.botName}
        onClose={() => setRoutinesOpen(false)}
        onOpenRoutine={(routineId) => {
          setRoutinesOpen(false);
          onOpenRoutine(routineId);
        }}
      />
      <NewChatSheet
        native={native}
        visible={newChatOpen}
        botId={botId}
        botName={header.botName}
        openChatTitles={links
          .filter((candidate) => candidate.botId === botId && candidate.archivedAt === null)
          .map((candidate) => shells.find((item) => item.id === candidate.threadId)?.title ?? "")}
        onClose={() => setNewChatOpen(false)}
        onCreated={(nextThreadId) => onOpenChat(botId, nextThreadId)}
      />
      <RenameChatSheet
        native={native}
        chat={chat}
        visible={renameOpen}
        threadId={threadId}
        initialTitle={thread?.title ?? shell?.title ?? ""}
        takenTitles={links
          .filter(
            (candidate) =>
              candidate.botId === botId &&
              candidate.archivedAt === null &&
              candidate.threadId !== threadId,
          )
          .map((candidate) => shells.find((item) => item.id === candidate.threadId)?.title ?? "")}
        onClose={() => setRenameOpen(false)}
        onSaved={() => setActionError(null)}
      />
      <SnoozeSheet
        native={native}
        visible={snoozeOpen}
        threadIds={[threadId]}
        onClose={() => setSnoozeOpen(false)}
        onSnoozed={() => setActionError(null)}
        onError={setActionError}
      />
      <MessageMenuSheet
        target={messageMenu}
        onClose={() => setMessageMenu(null)}
        onReply={(target) => {
          setReplyTo({
            messageId: target.messageId,
            name: target.name,
            excerpt: target.text.slice(0, 300),
          });
          setMessageMenu(null);
        }}
      />
      <FilePreviewSheet
        native={native}
        chat={chat}
        visible={filePath !== null}
        cwd={chatCwd}
        path={filePath}
        onClose={() => setFilePath(null)}
      />
    </View>
  );
}

function syntheticLink(
  botId: string,
  threadId: string,
  shell: EnvironmentThreadShell,
): PersonalBotThread {
  return {
    botId: botId as PersonalBotThread["botId"],
    threadId: threadId as PersonalBotThread["threadId"],
    createdAt: shell.createdAt as never,
    archivedAt: shell.archivedAt as never,
  };
}

function stateDotStyle(state: string) {
  switch (state) {
    case "needs_help":
    case "waiting":
    case "rate_limited":
    case "retrying":
      return { backgroundColor: tokens.needs };
    case "working":
      return { backgroundColor: tokens.working };
    case "error":
      return { backgroundColor: tokens.error };
    default:
      return { backgroundColor: tokens.textTertiary };
  }
}

function ChatHeader({
  title,
  subtitle,
  onBack,
  onMenu,
  onSearch,
}: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly onBack: () => void;
  readonly onMenu: (() => void) | null;
  readonly onSearch: (() => void) | null;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.iconButton}
      >
        <IconChevronLeft size={23} color={tokens.text} strokeWidth={1.75} />
      </Pressable>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== null ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {onSearch !== null ? (
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Search"
          style={styles.iconButton}
        >
          <IconSearch size={21} color={tokens.text} strokeWidth={1.75} />
        </Pressable>
      ) : null}
      {onMenu !== null ? (
        <Pressable
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel="Chat options"
          style={styles.iconButton}
        >
          <IconDots size={22} color={tokens.text} strokeWidth={1.75} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    paddingRight: 6,
    gap: 2,
  },
  headerIdentity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  headerText: { flex: 1, minWidth: 0, gap: 1 },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerTitle: {
    color: tokens.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: "700",
    flexShrink: 1,
  },
  titleChip: {
    color: tokens.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 1,
    maxWidth: "48%",
    flexShrink: 1,
  },
  contextBadge: {
    color: tokens.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 5,
  },
  subtitleRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  stateDot: { width: 7, height: 7, borderRadius: 999 },
  subtitle: { color: tokens.textSecondary, fontSize: 12, lineHeight: 17 },
  modelLabel: { color: tokens.textSecondary, fontSize: 12, lineHeight: 17, flexShrink: 1 },
  iconButton: { width: 42, height: 44, alignItems: "center", justifyContent: "center" },
  chipScroll: { height: 48, flexGrow: 0 },
  chips: { paddingHorizontal: 12, gap: 6, alignItems: "center" },
  chip: {
    minHeight: 32,
    maxWidth: 160,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: tokens.fillMuted,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  chipCurrent: { backgroundColor: tokens.primary },
  chipText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  chipTextCurrent: { color: tokens.primaryText, fontWeight: "600" },
  chipPin: { color: tokens.textSecondary, fontSize: 11 },
  chipDot: { width: 6, height: 6, borderRadius: 999 },
  chipUnreadDot: { backgroundColor: tokens.primary },
  newChip: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    justifyContent: "center",
  },
  newChipText: { color: tokens.text, fontSize: 13, fontWeight: "500" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  centerText: { color: tokens.textSecondary, fontSize: 15, textAlign: "center" },
  retry: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    justifyContent: "center",
  },
  retryText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  errorBox: {
    marginHorizontal: 16,
    marginVertical: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    backgroundColor: tokens.dangerBg,
    padding: 10,
  },
  errorText: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  archiveBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  archiveText: { color: tokens.textSecondary, fontSize: 13, flex: 1 },
  archiveAction: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  composerPlaceholder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  composerPlaceholderText: { color: tokens.textSecondary, fontSize: 15, paddingVertical: 10 },
  computerDock: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  computerDockText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  searchHeader: { paddingHorizontal: 8, paddingVertical: 6 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    borderRadius: 999,
    backgroundColor: tokens.fillMuted,
    paddingLeft: 14,
    paddingRight: 2,
  },
  searchInput: { flex: 1, color: tokens.text, fontSize: 16, paddingVertical: 8 },
  searchResults: { flex: 1, paddingHorizontal: 16 },
  searchEmpty: { color: tokens.textSecondary, fontSize: 14, textAlign: "center", marginTop: 28 },
  searchRow: {
    paddingVertical: 12,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  searchTitle: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  searchSnippet: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
});
