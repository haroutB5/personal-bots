import { useAtomRefresh } from "@effect/atom-react";
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
import {
  IconBellOff,
  IconChevronLeft,
  IconDeviceLaptop,
  IconDots,
  IconPhone,
  IconPlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { IDLE_RUN_WORK, runWork } from "@hbots/personal-client/conversation/liveWork";
import {
  chatSettingsArchiveInput,
  chatSettingsSheet,
  quotedChatName,
  type ChatSettingsRowId,
  type ChatSettingsTarget,
} from "@hbots/personal-client/bots/chatSettingsModel";
import { DEFAULT_TOKEN_USAGE_WINDOW } from "@hbots/personal-client/usage/tokenUsagePresentation";
import { motionForConversationState } from "@hbots/personal-client/bots/avatarMotionState";
import { readChatsSnapshot } from "@hbots/personal-client/bots/chatsSnapshot";
import { buildChatFeed } from "@hbots/personal-client/feed/chatFeed";
import { deriveLatestMessageReadStatus } from "@hbots/personal-client/feed/messageReadStatus";
import { sharedPreferencesFromProfile } from "@hbots/personal-client/settings/profilePreferences";
import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

import type { ChatEnvironment } from "../chat/chatEnvironment";
import type { FileOpenRequest } from "../chat/fileOpenRequest";
import { useThreadDetailView, useThreadRef } from "../chat/chatEnvironment";
import { useBotShells } from "../personal/useBotShells";
import {
  botVoiceCallColour,
  botVoiceCallsEnabled,
} from "@hbots/personal-client/voice/botVoiceCalls";
import { Composer } from "../chat/Composer";
import type { ComposerControl } from "../chat/Composer";
import { buildChatChips, chatContextUsage, chatHeaderModel, findChatBot } from "../chat/chatModel";
import { wasChatStartedHere } from "../chat/useStartChat";
import { chipScrollX } from "../chat/chipScroll";
import { ChipPill } from "../chat/ChipPill";
import { useFreshChipIds } from "../chat/useFreshChipIds";
import { chatKeyboardLayout } from "../chat/chatKeyboardLayout";
import { lastTurnStartMessageId } from "../chat/cards/contextTurn";
import { RulesUsageCard } from "../chat/cards/RulesUsageCard";
import { MessageList } from "../chat/MessageList";
import type { MessageListHandle } from "../chat/MessageList";
import { useChatCards } from "../chat/useChatCards";
import { PermissionCard } from "../notifications/PermissionCard";
import { permissionCardStore } from "../notifications/permissionCardRuntime";
import { pendingQuestionRequests } from "@hbots/personal-client/conversation/questionCards";
import { useNow } from "../chat/useNow";
import { useKeyboardInset } from "../platform/useKeyboardInset";
import { providerWaitState } from "@hbots/personal-client/conversation/conversationModel";
import type { PendingSend } from "../chat/composerSendModel";
import { RiseIn } from "../motion/RiseIn";
import type { ChatEntry } from "../nav/chatEntry";
import { BotAvatar } from "../shell/BotAvatar";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { BotUsageSheet } from "../sheets/BotUsageSheet";
import { ChatMenuSheet } from "../sheets/ChatMenuSheet";
import { ChatSettingsSheet } from "../sheets/ChatSettingsSheet";
import { chatMenuRows } from "../sheets/chatMenuRows";
import { ContextUsedSheet } from "../sheets/ContextUsedSheet";
import { RoutinesSheet } from "../sheets/RoutinesSheet";
import { FilePreviewSheet } from "../sheets/FilePreviewSheet";
import { MessageMenuSheet, type MessageMenuTarget } from "../sheets/MessageMenuSheet";
import { NewChatSheet } from "../sheets/NewChatSheet";
import { RenameChatSheet } from "../sheets/RenameChatSheet";
import { SnoozeSheet } from "../sheets/SnoozeSheet";
import { LiveVoiceCallCard } from "../voice/LiveVoiceCallCard";
import { useCallSession, useCallView } from "../voice/VoiceCallProvider";

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
  entry,
  onBack,
  onOpenChat,
  onOpenChats,
  onEditBot,
  onOpenRoutine,
  onOpenComputer,
}: {
  readonly native: NativePersonal;
  readonly chat: ChatEnvironment;
  readonly botId: string;
  readonly threadId: string;
  readonly entry: ChatEntry | undefined;
  readonly onBack: () => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onOpenChats: (botId: string) => void;
  readonly onEditBot: (botId: string) => void;
  readonly onOpenRoutine: (routineId: string) => void;
  readonly onOpenComputer: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const { shells } = useBotShells(native, environmentId);
  const list = native.bots.usePersonalBotsList(environmentId);
  const profile = native.bots.usePersonalProfile(environmentId);
  const providers = native.useProviders();
  const connection = native.useConnectionState();
  const ref = useThreadRef(environmentId, threadId);
  const view = useThreadDetailView(chat, ref);
  const retryThread = useAtomRefresh(chat.states.stateAtom(environmentId, ThreadId.make(threadId)));
  const now = useNow();
  const queued = useOutboxRows(threadId);
  const [pending, setPending] = useState<ReadonlyArray<PendingSend>>([]);
  const [replyTo, setReplyTo] = useState<PersonalReplyQuote | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsThreadId, setSettingsThreadId] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [usageWindow, setUsageWindow] = useState(DEFAULT_TOKEN_USAGE_WINDOW);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [renameThreadId, setRenameThreadId] = useState<string | null>(null);
  const [snoozeThreadId, setSnoozeThreadId] = useState<string | null>(null);
  const [messageMenu, setMessageMenu] = useState<MessageMenuTarget | null>(null);
  const [fileRequest, setFileRequest] = useState<FileOpenRequest | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchRows, setSearchRows] = useState<
    ReadonlyArray<{ threadId: string; snippet: string; title: string }>
  >([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [enteredVia] = useState(entry);
  const prewarmed = useRef(false);
  // eslint-disable-next-line react/purity -- open latency starts once per mount
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
  const composerControl = useRef<ComposerControl | null>(null);
  const revealCard = (itemId: string) => messageListControl.current?.scrollToCard(itemId);

  const interrupt = native.client.useAtomCommand(chat.thread.interruptTurn, {
    reportFailure: false,
  });
  const loadEarlierCommand = native.client.useAtomCommand(chat.thread.loadEarlierHistory, {
    reportFailure: false,
  });
  const updateThreads = native.client.useAtomCommand(native.bots.personalBotUpdateThreads, {
    reportFailure: false,
  });
  const archiveThreads = native.client.useAtomCommand(native.bots.personalBotArchiveThreads, {
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
  const callSession = useCallSession();
  const callView = useCallView();
  const callBot = record?.bot ?? null;
  const callsEnabled = callBot !== null && botVoiceCallsEnabled(callBot);
  const startCall = callsEnabled
    ? () => {
        if (callView.call !== null) {
          callSession?.setMinimised(false);
          return;
        }
        void callSession?.start({
          threadId,
          botId: callBot.botId,
          botName: callBot.name,
          avatarShape: callBot.avatarShape ?? "blob",
          avatarColor: botVoiceCallColour(callBot),
        });
      }
    : null;
  const cards = useChatCards({
    native,
    chat,
    environmentId,
    threadId,
    projection: view.projection,
    items,
    bots: list.data?.bots ?? [],
    botName: record?.bot?.name ?? "Bot",
    providers,
    nowMs: now,
    onOpenChat,
    voiceCallsEnabled: callsEnabled,
    onStartCall: startCall,
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
  // A send the transcript now shows arrived: drop its failed bubble and saved copy.
  const arrivedIds = useMemo(() => new Set(cards.items.map((item) => item.id)), [cards.items]);
  useEffect(() => {
    const arrived = pending.filter((message) => arrivedIds.has(message.id));
    if (arrived.length === 0) return;
    for (const message of arrived) composerControl.current?.forget(message.id);
  }, [arrivedIds, pending]);
  const contextUsage = useMemo(() => chatContextUsage(view.projection), [view.projection]);
  const questionOpen = useMemo(
    () => view.projection !== null && pendingQuestionRequests(view.projection).length > 0,
    [view.projection],
  );
  // Leaving a chat after sending is what arms the notification ask (SPEC 5e).
  useEffect(() => () => permissionCardStore.leftChat(), []);
  const work = useMemo(
    () => (view.projection === null ? IDLE_RUN_WORK : runWork(view.projection)),
    [view.projection],
  );
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
    contextUsage,
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
        startedHere: wasChatStartedHere(threadId),
      }),
    [botId, links, shells, threadId],
  );
  const freshChips = useFreshChipIds(chips.map((chip) => chip.threadId));
  const chipScrollRef = useRef<ScrollView | null>(null);
  const chipLayouts = useRef(new Map<string, { x: number; width: number }>());
  const chipOffset = useRef(0);
  const chipDidInitialScroll = useRef(false);
  const [chipViewportWidth, setChipViewportWidth] = useState(0);
  const [chipContentWidth, setChipContentWidth] = useState(0);
  const scrollChipIntoView = useCallback(
    (targetThreadId: string, animated: boolean): boolean => {
      const layout = chipLayouts.current.get(targetThreadId);
      if (layout === undefined || chipViewportWidth <= 0 || chipContentWidth <= 0) return false;
      const x = chipScrollX({
        chipX: layout.x,
        chipWidth: layout.width,
        currentX: chipOffset.current,
        viewportWidth: chipViewportWidth,
        contentWidth: chipContentWidth,
      });
      chipOffset.current = x;
      chipScrollRef.current?.scrollTo({ x, animated });
      return true;
    },
    [chipContentWidth, chipViewportWidth],
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (scrollChipIntoView(threadId, !chipDidInitialScroll.current)) {
        chipDidInitialScroll.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollChipIntoView, threadId]);
  const running = thread?.session?.status === "running" || thread?.session?.status === "starting";
  const hidePreviews = record?.bot != null && hidesBotPreviews(record.bot);
  // The strip shows the open chat even before its link is in the list; the menu does the same.
  const sheetLinks = useMemo(
    () =>
      link === null && shell !== null ? [...links, syntheticLink(botId, threadId, shell)] : links,
    [botId, link, links, shell, threadId],
  );
  const contextFraction =
    contextUsage === null || contextUsage.maxTokens === null
      ? null
      : Math.min(1, Math.max(0, contextUsage.usedTokens / contextUsage.maxTokens));
  // The ⋯ menu lists the open chat's own actions; a held tab still opens the settings sheet.
  const menuSettings = useMemo(
    () =>
      chatSettingsSheet({
        threadId: menuOpen ? threadId : null,
        currentThreadId: threadId,
        links: sheetLinks,
        shells,
        hidePreviews,
        openChatBusy: running,
        openChatLoaded: thread !== null,
        turnsUnavailable: false,
        wrapupSending: false,
        nowMs: now,
      }),
    [hidePreviews, menuOpen, now, running, sheetLinks, shells, thread, threadId],
  );
  const menuSections = useMemo(() => chatMenuRows(menuSettings?.groups ?? []), [menuSettings]);
  const settings = useMemo(
    () =>
      chatSettingsSheet({
        threadId: settingsThreadId,
        currentThreadId: threadId,
        links: sheetLinks,
        shells,
        hidePreviews,
        openChatBusy: running,
        openChatLoaded: thread !== null,
        turnsUnavailable: false,
        wrapupSending: false,
        nowMs: now,
      }),
    [hidePreviews, now, running, settingsThreadId, sheetLinks, shells, thread, threadId],
  );
  const renameShell =
    renameThreadId === null
      ? null
      : (shells.find((candidate) => candidate.id === renameThreadId) ?? null);
  const renameInitialTitle =
    renameThreadId === null
      ? ""
      : renameThreadId === threadId
        ? (thread?.title ?? shell?.title ?? "")
        : (renameShell?.title ?? "");

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
      // eslint-disable-next-line react/set-state-in-effect -- closing the search clears its results
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

  const closeSettings = () => setSettingsThreadId(null);

  const togglePin = async (target: ChatSettingsTarget) => {
    closeSettings();
    const result = await updateThreads({
      environmentId,
      input: {
        threadIds: [ThreadId.make(target.threadId)],
        pinned: !target.pinned,
      },
    });
    setActionError(failureText(result, "Couldn't update this chat."));
  };

  const archiveChat = async (target: Pick<ChatSettingsTarget, "threadId" | "archived">) => {
    closeSettings();
    const unavailable = target.archived
      ? "Couldn't unarchive this chat."
      : "Couldn't archive this chat.";
    const input = chatSettingsArchiveInput(target);
    const result = await archiveThreads({
      environmentId,
      input: {
        threadIds: input.threadIds.map((id) => ThreadId.make(id)),
        archived: input.archived,
      },
    });
    if (result._tag !== "Success") {
      setActionError(failureText(result, unavailable));
      return;
    }
    const failed = result.value.failed[0];
    setActionError(
      failed === undefined ? null : failed.message.length > 0 ? failed.message : unavailable,
    );
  };

  const remove = async (target: ChatSettingsTarget) => {
    closeSettings();
    const other = target.threadId !== threadId;
    const ok = await native.client.ports.confirm.confirm({
      title: other ? `Delete ${quotedChatName(target.title)}?` : "Delete this chat?",
      body: "The chat and its messages are removed for good.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const result = await deleteThread({
      environmentId,
      input: { threadId: ThreadId.make(target.threadId) },
    });
    if (result._tag === "Success") {
      if (!other) onBack();
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

  const wrapup = async (target: ChatSettingsTarget) => {
    closeSettings();
    if (target.threadId !== threadId || record?.bot == null || thread === null) return;
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

  const onSettingsRow = (id: ChatSettingsRowId) => runSettingsRow(id, settings?.target ?? null);

  const runSettingsRow = (id: ChatSettingsRowId, target: ChatSettingsTarget | null) => {
    if (target === null) {
      closeSettings();
      return;
    }
    switch (id) {
      case "pin":
      case "unpin":
        void togglePin(target);
        return;
      case "snooze":
        closeSettings();
        setSnoozeThreadId(target.threadId);
        return;
      case "wake":
        closeSettings();
        void updateThreads({
          environmentId,
          input: {
            threadIds: [ThreadId.make(target.threadId)],
            snoozedUntil: null,
          },
        });
        return;
      case "markUnread":
        closeSettings();
        void updateThreads({
          environmentId,
          input: {
            threadIds: [ThreadId.make(target.threadId)],
            markUnread: true,
          },
        });
        return;
      case "rename":
        closeSettings();
        setRenameThreadId(target.threadId);
        return;
      case "wrapup":
        void wrapup(target);
        return;
      case "archive":
      case "unarchive":
        void archiveChat(target);
        return;
      case "delete":
        void remove(target);
        return;
    }
  };

  const loadEarlier = () => {
    void loadEarlierCommand({
      environmentId,
      input: { threadId: ThreadId.make(threadId) },
    });
  };
  const history = view.state.history;
  const loadEarlierAvailable = history.hasMoreHistory;

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
              onPress={() => onEditBot(botId)}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${header.botName}`}
              style={styles.headerIdentity}
            >
              <BotAvatar
                shape={record?.bot?.avatarShape ?? cachedBot?.avatarShape ?? "blob"}
                color={record?.bot?.avatarColor ?? cachedBot?.avatarColor ?? tokens.primary}
                size={32}
                label={header.botName}
                motion={motionForConversationState(header.state, header.thinking)}
              />
              <View style={styles.headerText}>
                <View style={styles.headerTitleRow}>
                  <Text style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                    {header.botName}
                  </Text>
                  {header.muted ? (
                    <IconBellOff size={15} color={tokens.textSecondary} strokeWidth={2} />
                  ) : null}
                </View>
                {/* With one chat there is no tab strip, so its title sits here instead. */}
                {chips.length < 2 && header.chatTitle !== null ? (
                  <Text
                    style={styles.subtitle}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.3}
                    accessibilityLabel={`Chat: ${header.chatTitle}`}
                  >
                    {header.chatTitle}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ) : (
            <View style={styles.headerText}>
              <Text style={styles.headerTitle}>{thread?.title ?? "Chat"}</Text>
            </View>
          )}

          {startCall === null ? null : (
            <Pressable
              onPress={startCall}
              accessibilityRole="button"
              accessibilityLabel={
                callView.call === null ? `Call ${header.botName}` : "Return to the call"
              }
              style={styles.iconButton}
            >
              <IconPhone size={22} color={tokens.text} strokeWidth={1.75} />
            </Pressable>
          )}
          <Pressable
            onPress={() => setNewChatOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`New chat with ${header.botName}`}
            style={styles.iconButton}
          >
            <IconPlus size={22} color={tokens.text} strokeWidth={1.75} />
          </Pressable>
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

      {!searchOpen && thread !== null ? (
        <Pressable
          onPress={() => setContextOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={[
            header.stateLabel,
            header.modelLabel,
            header.contextBadge === null ? null : `Context ${header.contextBadge} tokens`,
          ]
            .filter((part): part is string => part !== null)
            .join(", ")}
          accessibilityHint="Shows what is in the context"
          style={styles.statusLine}
        >
          <View style={[styles.stateDot, stateDotStyle(header.state)]} />
          <Text style={styles.statusText} numberOfLines={2} maxFontSizeMultiplier={1.3}>
            <Text style={styles.statusState}>{header.stateLabel}</Text>
            {header.modelLabel === null ? null : ` · ${header.modelLabel}`}
          </Text>
          {header.contextBadge === null ? null : (
            <View style={styles.contextMeter}>
              {contextFraction === null ? null : (
                <View style={styles.contextTrack}>
                  <View style={[styles.contextFill, { width: `${contextFraction * 100}%` }]} />
                </View>
              )}
              <Text style={styles.contextText} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {header.contextBadge}
              </Text>
            </View>
          )}
        </Pressable>
      ) : null}

      {!searchOpen && chips.length >= 2 ? (
        <ScrollView
          ref={chipScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          onScroll={(event) => {
            chipOffset.current = event.nativeEvent.contentOffset.x;
          }}
          scrollEventThrottle={16}
          onLayout={(event) => setChipViewportWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={(width) => setChipContentWidth(width)}
          contentContainerStyle={styles.chips}
          style={styles.chipScroll}
        >
          {chips.map((chip) => (
            <ChipPill
              key={chip.threadId}
              current={chip.current}
              fresh={freshChips.has(chip.threadId)}
              style={styles.chip}
              currentStyle={styles.chipCurrent}
              onLayout={(event) => {
                const { x, width } = event.nativeEvent.layout;
                chipLayouts.current.set(chip.threadId, { x, width });
                if (!chip.current) return;
                requestAnimationFrame(() => {
                  if (scrollChipIntoView(chip.threadId, !chipDidInitialScroll.current)) {
                    chipDidInitialScroll.current = true;
                  }
                });
              }}
              onPress={() => {
                if (!chip.current) onOpenChat(botId, chip.threadId);
              }}
              onLongPress={() => setSettingsThreadId(chip.threadId)}
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
            </ChipPill>
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
            <RiseIn enabled={enteredVia === "chip"} style={styles.riseHost}>
              <MessageList
                native={native}
                chat={chat}
                cardContext={cards.context}
                items={cards.items}
                pending={pending}
                queued={queued}
                botName={header.botName}
                currentUserId="You"
                work={work}
                busy={running || archived}
                latestMessageStatus={latestMessageStatus}
                onReply={(quote) => setReplyTo(quote)}
                onMessageMenu={setMessageMenu}
                onOpenFile={(request) => setFileRequest(request)}
                onOpenLink={(url) => {
                  void Linking.openURL(url).catch(() => setActionError("Couldn't open that link."));
                }}
                onChoose={(text) =>
                  composerControl.current?.sendText(text) ?? Promise.resolve(false)
                }
                onCancelQueued={(id) => removeOutboxEntry(id)}
                onRetryQueued={(id) => {
                  retryOutboxEntry(id);
                  // Retry means now. A socket waiting out its backoff would
                  // otherwise turn the tap into another 20 s of "Sending…".
                  if (!native.readConnection().connected) native.retry();
                }}
                onRetryPending={(id) => void composerControl.current?.retry(id)}
                onLoadEarlier={loadEarlierAvailable ? loadEarlier : null}
                loadEarlierBusy={history.loading}
                listControl={messageListControl}
                onHeightChange={setListHeight}
                keyboardInset={keyboard.padding}
              />
            </RiseIn>
            {archived ? (
              <View style={[styles.archiveBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
                <Text style={styles.archiveText}>Archived · Unarchive to send messages again.</Text>
                <Pressable
                  onPress={() => void archiveChat({ threadId, archived })}
                  accessibilityRole="button"
                >
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
                <PermissionCard botName={header.botName} questionOpen={questionOpen} />
                <View
                  style={{ paddingBottom: Math.max(insets.bottom, 8) }}
                  onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
                >
                  <LiveVoiceCallCard threadId={threadId} />
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
                    onSent={() => permissionCardStore.messageSent()}
                    control={composerControl}
                  />
                </View>
              </>
            )}
          </>
        )}
      </View>

      <ChatMenuSheet
        visible={menuOpen}
        title={header.chatTitle ?? "Chat options"}
        bot={record?.bot ?? null}
        running={running}
        providerWait={providerWait}
        nowMs={now}
        sections={menuSections}
        onClose={() => setMenuOpen(false)}
        onStop={() => void stop()}
        onSwitchModel={() => {
          setMenuOpen(false);
          onEditBot(botId);
        }}
        onChatRow={(id) => {
          const target = menuSettings?.target ?? null;
          setMenuOpen(false);
          runSettingsRow(id, target);
        }}
        onSearch={() => {
          setMenuOpen(false);
          setSearchOpen(true);
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
        onRoutines={() => {
          setMenuOpen(false);
          setRoutinesOpen(true);
        }}
      />
      <ChatSettingsSheet
        visible={settingsThreadId !== null}
        header={settings?.header ?? null}
        groups={settings?.groups ?? []}
        onClose={closeSettings}
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
        visible={renameThreadId !== null}
        threadId={renameThreadId ?? threadId}
        initialTitle={renameInitialTitle}
        takenTitles={links
          .filter(
            (candidate) =>
              candidate.botId === botId &&
              candidate.archivedAt === null &&
              candidate.threadId !== renameThreadId,
          )
          .map((candidate) => shells.find((item) => item.id === candidate.threadId)?.title ?? "")}
        onClose={() => setRenameThreadId(null)}
        onSaved={() => setActionError(null)}
      />
      <SnoozeSheet
        native={native}
        visible={snoozeThreadId !== null}
        threadIds={snoozeThreadId === null ? [] : [snoozeThreadId]}
        onClose={() => setSnoozeThreadId(null)}
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
        visible={fileRequest !== null}
        threadId={threadId}
        request={fileRequest}
        onClose={() => setFileRequest(null)}
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
  riseHost: { flex: 1 },
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
  statusLine: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  statusText: { flex: 1, color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  statusState: { color: tokens.text, fontWeight: "500" },
  contextMeter: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  contextTrack: {
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: tokens.track,
    overflow: "hidden",
  },
  contextFill: { height: 5, borderRadius: 999, backgroundColor: tokens.primary },
  contextText: {
    color: tokens.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    fontVariant: ["tabular-nums"],
  },
  stateDot: { width: 7, height: 7, borderRadius: 999 },
  subtitle: { color: tokens.textSecondary, fontSize: 12, lineHeight: 17, flexShrink: 1 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
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
    minHeight: 44,
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
