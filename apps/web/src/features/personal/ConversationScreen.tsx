import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  derivePendingRequests,
  deriveUserInputHistory,
  type PendingUserInput,
} from "@t3tools/client-runtime/pending-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import {
  botEffectiveModelSelection,
  PersonalSecretRequestId,
  type ApprovalRequestId,
  type EnvironmentId,
  type PersonalReplyQuote,
  type PersonalSecretRequest,
  type PersonalTask,
  type ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { ChevronLeft, Ellipsis, PanelRightClose, PanelRightOpen } from "lucide-react";

import { buildRunningThreadTurnInterruptInput } from "~/components/ChatView.logic";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import {
  derivePhase,
  deriveTimelineEntriesWithState,
  deriveWorkLogEntries,
  type TimelineEntriesProjection,
} from "~/session-logic";
import {
  useProject,
  useThreadDetail,
  useThreadShell,
  useThreadShells,
  useThreadStatus,
} from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";
import {
  threadEnvironment,
  useEnvironmentThread,
  useRetryEnvironmentThread,
} from "~/state/threads";
import type { ChatMessage } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import { perfOptimizationOn } from "./perfFlags";
import { motionForConversationState } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { AllChatsCount } from "./AllChatsCount";
import { ArchivedChatBar } from "./ArchivedChatBar";
import { CHAT_PROBLEM_BUTTON, ChatLoadProblem } from "./ChatLoadProblem";
import { threadLoadProblem } from "./threadLoadProblem";
import { BotMuteMenuItems, useSetBotMute } from "./BotMute";
import { ChatChips } from "./ChatChips";
import { markChatSwitched, rememberChipsShown } from "./chatChipHandoff";
import { buildChatChips } from "./chatChipRows";
import { isChatPinned } from "./chatState";
import { SnoozeSheet } from "./SnoozeSheet";
import { useBulkChatActions } from "./useBulkChatActions";
import { useSnoozeWakeClock } from "./useSnoozeWakeClock";
import { ConversationHeaderLine, ConversationHeaderName } from "./ConversationHeaderName";
import { ConversationSubtitle } from "./ConversationSubtitle";
import { QuietNoticeLine, type QuietNotice } from "./QuietNoticeLine";
import { ownerCardPending, useQuietSince } from "./chatSilence";
import { botMuteState } from "./botMuteModel";
import {
  conversationHeaderStatus,
  providerShortName,
  resolveBotProvider,
  taskCardBotLine,
} from "./botSummaries";
import { botActiveModelShortLabel, fallbackNoteLabel } from "./botModelLabel";
import { commandFailureMessage } from "./commandFeedback";
import { ConversationComputerLink } from "./ConversationComputerLink";
import { ConversationDesktopLine } from "./ConversationDesktopLine";
import { useLeaveResumedChatIfGone } from "./resumeLastChat";
import { useCloseChatNotifications } from "./staleNotifications";
import { useDesktopStatus } from "./computer/desktopState";
import { useComputerFeed } from "./computer/computerState";
import { ConversationRoutinesPanel } from "./ConversationRoutinesPanel";
import { CONVERSATION_SIDE_PANEL_ID, ConversationSidePanel } from "./ConversationSidePanel";
import {
  buildConversationItems,
  contextBadgeLabel,
  conversationHeaderStateLabel,
  type ConversationState,
  deriveConversationState,
  friendlyTurnError,
  isTurnThinking,
  placeDelegationCards,
  placeQuestionCards,
  placeSecretRequestCards,
  placeLoginRequestCards,
  placeConnectionApprovalCards,
  placeLeadBotChangeCards,
  placeMemoryCards,
  resolveConversationHeaderName,
  turnErrorNotice,
} from "./conversationModel";
import { deriveLatestMessageReadStatus } from "./messageReadStatus";
import { DelegationCard } from "./DelegationCard";
import { useChatSidePanel } from "./desktopColumns";
import {
  delegatedChildren,
  resolveTurnChildren,
  type ServerTurn,
  serverTurnLabel,
  waitingLabelsByThread,
} from "./delegationModel";
import { MessageList, type PendingOutgoingMessage } from "./MessageList";
import {
  deriveQuestionCards,
  deriveUserInputResolutions,
  type UserInputAnswers,
} from "./questionCards";
import { deriveSecretRequestCards, type SecretRequestOutcome } from "./secretRequestCards";
import type { ProvideSecret } from "./SecretRequestCard";
import { useConnectionApprovalCards } from "./useConnectionApprovalCards";
import { useLeadBotChangeCards } from "./useLeadBotChangeCards";
import { useMemoryCards } from "./useMemoryCards";
import { useLoginRequestCards } from "./useLoginRequests";
import {
  personalSecretCancel,
  personalSecretFulfill,
  usePendingSecretRequests,
} from "./useSecretRequests";
import { setPersonalPreference, usePersonalPreference } from "./personalPreferences";
import { diagnosticsEnabled, DiagnosticsOverlay } from "./DiagnosticsOverlay";
import { useKeyboardInset } from "./useKeyboardInset";
import { useReportViewingThread } from "./useReportViewingThread";
import { readChatNotice } from "./chatNotices";
import { useChatSeenState, useMarkChatSeen, useRefetchOnTurnsSettled } from "./unreadChats";
import { markMessageSent, observeChatMessages, reportChatUsable } from "./perfRum";
import { warmHighlighterWhenIdle } from "./highlighterWarmup";
import { PersonalComposer } from "./PersonalComposer";
import { ProgressNoteLine } from "./ProgressNoteLine";
import { deriveLatestProgressNote } from "./latestProgress";
import { useLaptopOffline, usePersonalConnectionPhase } from "./PersonalOfflineBanner";
import { useNewChatPrompt } from "./useNewChatPrompt";
import { usePersonalRelatedTasks, usePersonalTasks } from "./usePersonalAutomation";
import { usePrewarmChatSession } from "./usePrewarmChatSession";
import { mergeTaskLists } from "./taskPresentation";
import {
  personalBotArchiveThread,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";
import { useRefreshBotsForTaskThreads } from "./useRefreshBotsForTaskThreads";
import { useWrapupChat } from "./wrapupChat";
import { useDeleteChat } from "./useDeleteChat";
import { RenameChatDialog } from "./RenameChatDialog";
import { pendingForThread } from "./pendingOutgoing";
import { renameChatInitialTitle, useRenameChat } from "./renameChat";
import { findRetryTarget, useRetryFailedTurn } from "./retryFailedTurn";
import { usePersonalBackTarget } from "./usePersonalBackTarget";
import { usePersonalGroupRelayThreadIds } from "./usePersonalGroups";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_SECRET_REQUESTS: ReadonlyArray<PersonalSecretRequest> = [];
const EMPTY_ACTIVITIES: ReadonlyArray<never> = [];
const EMPTY_PLANS: ReadonlyArray<never> = [];

/** Minute clock for "Today, 21:38" dividers. */
function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * /bots/$botId/$threadId (ui-spec Screen 2): focused chat with no tab bar.
 * Everything shown comes from the thread's live detail stream (messages,
 * activities, session, latest turn) and the bot record.
 */
export function ConversationScreen({
  botId,
  threadId: threadIdParam,
}: {
  botId: string;
  threadId: string;
}): JSX.Element {
  const navigate = useNavigate();
  const backTarget = usePersonalBackTarget();
  const environmentId = usePersonalEnvironmentId();
  const threadId = ThreadId.make(threadIdParam);
  const threadRef = useMemo(
    () => (environmentId === null ? null : scopeThreadRef(environmentId, threadId)),
    [environmentId, threadId],
  );
  const list = usePersonalBotsList(environmentId);
  const bot = list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  const headerName = resolveConversationHeaderName({
    botName: bot?.name ?? null,
    botsLoaded: list.data !== null,
  });
  const thread = useThreadDetail(threadRef);
  // The header title reads the shell: renames and auto-titles reach it live,
  // while the loaded detail keeps the title it was fetched with.
  const threadShell = useThreadShell(threadRef);
  const status = useThreadStatus(threadRef);
  useCloseChatNotifications(botId, threadIdParam);
  // An archived chat opens read-only: the history, an "Archived" bar with
  // Unarchive and Delete in the composer's place, and nothing that starts a
  // turn or a provider session.
  const link = list.data?.threads.find((candidate) => candidate.threadId === threadIdParam) ?? null;
  const archived =
    (threadShell?.archivedAt ?? null) !== null || (link?.archivedAt ?? null) !== null;
  // Reopened by a relaunch but deleted or archived since (deleting a bot
  // deletes its chats): back to Bots without a word.
  useLeaveResumedChatIfGone(`/bots/${botId}/${threadIdParam}`, status === "deleted" || archived);

  // A cold deep link (notification tap, PWA relaunch) makes this the first
  // screen: nothing else has loaded the bots list, and a query that failed
  // before the connection came up stays failed. Ask once per failure, and
  // once more when a loaded list lacks this bot (created after it cached).
  const refreshBotsList = list.refresh;
  const listNeedsRefresh =
    environmentId !== null && !list.isPending && (list.data === null || bot === null);
  const listRefreshKey = `${environmentId}|${botId}|${list.data === null ? "none" : "stale"}|${list.error ?? ""}`;
  const lastListRefreshKey = useRef<string | null>(null);
  useEffect(() => {
    if (!listNeedsRefresh || lastListRefreshKey.current === listRefreshKey) return;
    lastListRefreshKey.current = listRefreshKey;
    refreshBotsList();
  }, [listNeedsRefresh, listRefreshKey, refreshBotsList]);
  const threadState = useEnvironmentThread(environmentId, threadId);
  const loadProblem = threadLoadProblem(threadState);
  const retryThread = useRetryEnvironmentThread(environmentId, threadId);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const project = useProject(
    environmentId !== null && thread !== null
      ? scopeProjectRef(environmentId, thread.projectId)
      : null,
  );
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const archiveThread = useAtomCommand(personalBotArchiveThread);
  // Neither failures nor defects are reported to the console for this one: the
  // card shows the server's own message instead, and a defect cause is the one
  // place a client-side encode error could carry the encoded payload with it.
  const fulfillSecret = useAtomCommand(personalSecretFulfill, {
    reportFailure: false,
    reportDefect: false,
  });
  const cancelSecret = useAtomCommand(personalSecretCancel, { reportFailure: false });
  const newChat = useNewChatPrompt(environmentId, bot);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useKeyboardInset(shellRef);
  const now = useMinuteNow();
  const setBotMute = useSetBotMute(environmentId);
  const [pending, setPending] = useState<ReadonlyArray<PendingOutgoingMessage>>([]);
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const laptopOffline = useLaptopOffline();
  const connectionPhase = usePersonalConnectionPhase();
  // Reading this chat right now means its own notifications stay off the
  // phone; every other chat still notifies.
  // Both wait until the shell and the bots list say whether the chat is
  // archived. An archived chat is only read: no session is warmed, and it is
  // not reported as viewed (that writes its last-viewed time on the server).
  const openForWork =
    threadShell !== null && (list.data !== null || list.error !== null) && !archived;
  useReportViewingThread(environmentId, threadId, connectionPhase === "connected" && openForWork);
  // Open and visible here: not unread on the Bots list, read up to when it closes.
  useMarkChatSeen(threadId, openForWork);
  usePrewarmChatSession(environmentId, threadId, connectionPhase === "connected" && openForWork);
  const { feed: computerFeed } = useComputerFeed(environmentId);
  const desktopStatus = useDesktopStatus(environmentId);

  // Delegation state comes from the live task feed (personalTasks.subscribe).
  // The feed carries only recent finished tasks, so an older chat's own tasks
  // and their delegated children are fetched once for this chat and folded in.
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const threadTasks = usePersonalRelatedTasks(environmentId, { threadId });
  const tasks = useMemo(() => {
    const merged = mergeTaskLists(taskFeed, threadTasks);
    return merged === null ? [] : [...merged.values()];
  }, [taskFeed, threadTasks]);
  const botsById = useMemo(
    () => new Map((list.data?.bots ?? []).map((entry) => [entry.botId as string, entry] as const)),
    [list.data],
  );
  const nameOf = useCallback((id: string) => botsById.get(id)?.name ?? null, [botsById]);
  const waitingLabels = useMemo(() => waitingLabelsByThread(tasks, nameOf), [tasks, nameOf]);
  const waitingLabel = waitingLabels.get(threadId) ?? null;
  const children = useMemo(() => delegatedChildren(threadId, tasks), [threadId, tasks]);
  // A bot a team lead created and handed work in the same turn is not in this
  // device's list yet: its card would read "Deleted bot" until the list is refetched.
  useRefreshBotsForTaskThreads({
    bots: list.data?.bots ?? null,
    links: list.data?.threads ?? null,
    tasks: children,
    refresh: list.refresh,
  });

  const messages = (thread?.messages as ReadonlyArray<ChatMessage> | undefined) ?? EMPTY_MESSAGES;
  // Real-user timings (perfRum.ts): chat usable, then send -> echo -> first reply text.
  const usableThreadId = thread !== null ? threadId : null;
  useEffect(() => {
    if (usableThreadId === null) return;
    reportChatUsable(window.location.pathname);
  }, [usableThreadId]);
  useEffect(() => {
    observeChatMessages(threadId, messages);
  }, [threadId, messages]);
  const pendingCount = useRef(0);
  useEffect(() => {
    if (pending.length > pendingCount.current) {
      markMessageSent(threadId, messages);
      // Compile the code-highlighting grammars while the reply is being
      // written (seconds), not while the user may still be typing.
      warmHighlighterWhenIdle();
    }
    pendingCount.current = pending.length;
    // Only a new pending message starts a send; the messages it saw are a snapshot.
  }, [pending.length, threadId, messages]);
  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const proposedPlans = thread?.proposedPlans ?? EMPTY_PLANS;
  const workEntries = useMemo(() => deriveWorkLogEntries(activities), [activities]);
  // Incremental projection, as upstream ChatView does: a streaming delta
  // extends the previous timeline instead of re-folding and re-sorting it.
  const projectionRef = useRef<{
    threadId: ThreadId;
    projection: TimelineEntriesProjection;
  } | null>(null);
  const showToolSteps = usePersonalPreference("showToolSteps");
  const showRoutinesStrip = usePersonalPreference("showRoutinesStrip");
  // Wide desktop: the Computer and the routines sit in a panel beside the chat
  // instead of the link and strip under it. Below the width the chat is laid
  // out exactly as it always was.
  const { fits: sidePanelFits, open: sidePanelOpen } = useChatSidePanel();
  /* oxlint-disable react/refs -- The ref is a pure render cache, not UI state:
     it only ever holds the last projection for the last thread, and dropping it
     costs a full re-fold, never a different result. Moving the read or the
     write out of render would change WHEN the timeline rebuilds (a frame late,
     or on every delta), which is the one thing this incremental path exists to
     avoid, so the rule is suppressed here rather than the pattern rewritten. */
  const baseItems = useMemo(() => {
    const previous = projectionRef.current;
    const projection = deriveTimelineEntriesWithState(
      messages,
      proposedPlans,
      workEntries,
      previous?.threadId === threadId ? previous.projection : null,
    );
    projectionRef.current = { threadId, projection };
    return buildConversationItems(projection.entries, { showToolSteps });
    // `projectionRef` is stable for the component's life, so naming it here is
    // a no-op at runtime; it is listed only because the memo reads it.
  }, [threadId, messages, proposedPlans, workEntries, showToolSteps, projectionRef]);
  /* oxlint-enable react/refs */
  const delegationItems = useMemo(
    () => placeDelegationCards(baseItems, children),
    [baseItems, children],
  );
  const describeTurn = useCallback(
    (turn: ServerTurn) => serverTurnLabel(turn, resolveTurnChildren(turn, tasks), nameOf),
    [tasks, nameOf],
  );
  const renderDelegation = useCallback(
    (task: PersonalTask) => {
      const childBot = botsById.get(task.botId) ?? null;
      return (
        <DelegationCard
          environmentId={environmentId!}
          task={task}
          bot={childBot}
          modelLabel={taskCardBotLine(childBot, providers)}
          waitingFor={task.threadId === null ? null : (waitingLabels.get(task.threadId) ?? null)}
        />
      );
    },
    [botsById, environmentId, providers, waitingLabels],
  );
  const { approvals, userInputs } = useMemo(() => derivePendingRequests(activities), [activities]);
  // Answering removes the request from `userInputs` the moment the server
  // resolves it. Remembering every request this screen has shown keeps the card
  // in place afterwards, showing the answer instead of leaving a gap where the
  // question was. Scoped to the open thread, so history stays out of the way.
  const [seenUserInputs, setSeenUserInputs] = useState<{
    threadId: ThreadId;
    requests: ReadonlyMap<string, PendingUserInput>;
  }>(() => ({ threadId, requests: new Map() }));
  // Adjusted during render rather than in an effect: the card must never blink
  // out between the answer landing and the memory catching up.
  const sameThreadAsSeen = seenUserInputs.threadId === threadId;
  if (
    !sameThreadAsSeen ||
    userInputs.some((request) => !seenUserInputs.requests.has(request.requestId))
  ) {
    const requests = new Map(sameThreadAsSeen ? seenUserInputs.requests : []);
    for (const request of userInputs) requests.set(request.requestId, request);
    setSeenUserInputs({ threadId, requests });
  }
  // The chat's own context size, shown in the header at any size once the chat has reported one.
  const contextBadge = useMemo(
    () => contextBadgeLabel(deriveLatestContextWindowSnapshot(activities)?.usedTokens),
    [activities],
  );
  const questionCards = useMemo(() => {
    // Every question ever asked on this thread, so reopening a chat still shows
    // what was asked and answered instead of a reply to an invisible question.
    // The in-session memory layers on top: a question answered a moment ago has
    // left `pending` before its resolution reaches the activity stream.
    const asked = new Map<string, PendingUserInput>(
      deriveUserInputHistory(activities).map((request) => [request.requestId as string, request]),
    );
    // A thread switch that has not settled yet must not show the previous
    // chat's cards.
    if (seenUserInputs.threadId === threadId) {
      for (const [requestId, request] of seenUserInputs.requests) asked.set(requestId, request);
    }
    return deriveQuestionCards(userInputs, asked, deriveUserInputResolutions(activities));
  }, [activities, seenUserInputs, threadId, userInputs]);
  // Secrets the bot asked for. `listPending` drops a row the moment it is
  // answered, so the same seen/outcome memory as the question cards keeps the
  // card in place with its ending instead of leaving a hole in the transcript.
  const pendingSecretsQuery = usePendingSecretRequests(environmentId);
  const pendingSecrets = pendingSecretsQuery.data?.requests ?? EMPTY_SECRET_REQUESTS;
  const [seenSecrets, setSeenSecrets] = useState<ReadonlyMap<string, PersonalSecretRequest>>(
    () => new Map(),
  );
  const [secretOutcomes, setSecretOutcomes] = useState<ReadonlyMap<string, SecretRequestOutcome>>(
    () => new Map(),
  );
  if (pendingSecrets.some((request) => !seenSecrets.has(request.requestId))) {
    const next = new Map(seenSecrets);
    for (const request of pendingSecrets) next.set(request.requestId, request);
    setSeenSecrets(next);
  }
  const secretRequestCards = useMemo(
    () => deriveSecretRequestCards(pendingSecrets, threadId, seenSecrets, secretOutcomes),
    [pendingSecrets, secretOutcomes, seenSecrets, threadId],
  );
  // Gated vendor calls, shared with the group screen so both can answer one.
  const connectionApprovals = useConnectionApprovalCards(environmentId, threadId);
  const connectionApprovalCards = connectionApprovals.cards;
  // A team lead asking to remove or rewrite a bot it did not create.
  const leadBotChanges = useLeadBotChangeCards(environmentId, threadId);
  const leadBotChangeCards = leadBotChanges.cards;
  // A bot's save or forget of memory other bots see, waiting for the owner.
  const memoryChanges = useMemoryCards(environmentId, threadId);
  const memoryChangeCards = memoryChanges.cards;
  const loginRequests = useLoginRequestCards(environmentId, threadId);
  // The cards the bot put in the conversation belong in it: an answered
  // question keeps the spot where it was asked, so the bot's next reply reads
  // below it instead of above a card stuck at the bottom of the chat.
  const items = useMemo(
    () =>
      placeMemoryCards(
        placeLoginRequestCards(
          placeLeadBotChangeCards(
            placeConnectionApprovalCards(
              placeSecretRequestCards(
                placeQuestionCards(delegationItems, questionCards),
                secretRequestCards,
              ),
              connectionApprovalCards,
            ),
            leadBotChangeCards,
          ),
          loginRequests.cards,
        ),
        memoryChangeCards,
      ),
    [
      connectionApprovalCards,
      delegationItems,
      leadBotChangeCards,
      memoryChangeCards,
      questionCards,
      secretRequestCards,
      loginRequests.cards,
    ],
  );

  const conversationState = deriveConversationState({
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
    pendingApprovals: approvals,
    pendingUserInputs: userInputs,
    browserStatus: computerFeed.status,
    threadId,
    waitingForAgent: waitingLabel !== null,
  });
  // The avatar's thinking pose: working, but no reply text or tool call yet.
  const turnThinking =
    conversationState === "working" &&
    isTurnThinking({
      session: thread?.session ?? null,
      latestTurn: thread?.latestTurn ?? null,
      activities,
    });
  const phase = derivePhase(thread?.session ?? null);
  // Stop depends on the thread alone, never on the bots list.
  const interruptInput = buildRunningThreadTurnInterruptInput(thread, phase);
  // "Working" drives the typing indicator; a turn parked on a provider wait
  // still occupies the composer (Stop, no send) without claiming progress.
  const working = conversationState === "working";
  const providerWait = conversationState === "rate_limited" || conversationState === "retrying";
  const turnBusy =
    working || (providerWait && thread?.session !== null && thread?.session?.status !== "error");
  const latestTurn = thread?.latestTurn ?? null;
  // A working bot that has sent nothing for 90 s: the header says so, with a
  // live timer, in place of "Working". Time spent waiting on the owner (a
  // secret, login or approval card) and time offline do not count.
  const quietSinceMs = useQuietSince({
    active: working && !laptopOffline && !ownerCardPending(items),
    chatKey: threadId,
    stamps: [thread?.updatedAt],
  });
  const quiet: QuietNotice | null =
    quietSinceMs === null || bot === null
      ? null
      : {
          provider: providerShortName(bot.modelSelection.instanceId, providers),
          sinceMs: quietSinceMs,
        };
  // One muted line of what the running turn is doing, for models that keep
  // their progress in thinking summaries and would otherwise read as blank.
  const progressNote = useMemo(
    () => deriveLatestProgressNote({ working, messages, activities, latestTurn }),
    [working, messages, activities, latestTurn],
  );
  const latestMessageStatus = useMemo(
    () =>
      deriveLatestMessageReadStatus({ items: baseItems, activities, busy: turnBusy, latestTurn }),
    [baseItems, activities, turnBusy, latestTurn],
  );
  const stateLabel = conversationHeaderStateLabel({
    state: conversationState,
    thinking: turnThinking,
    waitingLabel,
    session: thread?.session ?? null,
    now,
  });
  const provider =
    bot === null ? null : resolveBotProvider(bot.modelSelection.instanceId, providers);
  const headerStatus = conversationHeaderStatus(conversationState, stateLabel, provider);
  const headerModelLabel = bot === null ? null : botActiveModelShortLabel(bot, providers);
  const headerModelNote = bot === null ? null : fallbackNoteLabel(bot);
  // A typed message, Retry and wrapup send what the bot runs on right now (its fallback while on it).
  const botTurnModel = bot === null ? null : botEffectiveModelSelection(bot);

  const visiblePending = useMemo(
    () => pendingForThread(pending, threadId, messages),
    [messages, pending, threadId],
  );

  // The owner's last message, for the failed-turn notice's Retry.
  const retryTarget = useMemo(() => findRetryTarget(messages), [messages]);
  const failedTurnRetry = useRetryFailedTurn({
    environmentId,
    thread,
    botModelSelection: botTurnModel,
    target: retryTarget,
    failureKey: thread?.session?.updatedAt ?? null,
  });

  const onInterrupt = useCallback(async (): Promise<string | null> => {
    if (environmentId === null || interruptInput === null) return null;
    const result = await interruptTurn({ environmentId, input: interruptInput });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      return error instanceof Error ? error.message : "Couldn't stop this turn.";
    }
    return null;
  }, [environmentId, interruptInput, interruptTurn]);

  const onRespondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (environmentId === null) return;
    setRespondingIds((current) => new Set(current).add(requestId));
    const result = await respondToApproval({
      environmentId,
      input: { threadId, requestId, decision },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : "Couldn't send your decision.");
    } else {
      setActionError(null);
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
  };

  // Answering a question the bot asked. The same RPC the developer view uses;
  // the card here is only a phone-shaped front for it.
  const onAnswerQuestion = async (requestId: string, answers: UserInputAnswers) => {
    if (environmentId === null) return;
    setRespondingIds((current) => new Set(current).add(requestId));
    const result = await respondToUserInput({
      environmentId,
      input: { threadId, requestId: requestId as ApprovalRequestId, answers },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const fallback = "Couldn't send your answer. Try again.";
      setActionError(
        error instanceof Error ? friendlyTurnError(error.message, fallback).message : fallback,
      );
    } else {
      setActionError(null);
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
  };

  // Closes an async question without replying: the bot is not messaged.
  const onDismissQuestion = async (requestId: string) => {
    if (environmentId === null) return;
    setRespondingIds((current) => new Set(current).add(requestId));
    const result = await dismissUserInput({
      environmentId,
      input: { threadId, requestId: requestId as ApprovalRequestId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const fallback = "Couldn't close this question. Try again.";
      setActionError(
        error instanceof Error ? friendlyTurnError(error.message, fallback).message : fallback,
      );
    } else {
      setActionError(null);
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
  };

  // Providing a secret. The value is passed straight through to the RPC as a
  // Redacted payload and is never held here, logged, or put in any store: the
  // only copy on this device was the card's own input, already cleared.
  const onProvideSecret: ProvideSecret = async (requestId, value, shared, access) => {
    if (environmentId === null) return;
    setRespondingIds((current) => new Set(current).add(requestId));
    const result = await fulfillSecret({
      environmentId,
      input: {
        requestId: PersonalSecretRequestId.make(requestId),
        value: Redacted.make(value),
        shared,
        mode: access.mode,
        origins: [...access.origins],
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      // The server never echoes the value, and neither does this: only its own
      // message ("Secret value must be at most 4096 bytes.") reaches the alert.
      setActionError(
        error instanceof Error ? error.message : "Couldn't save this secret. Try again.",
      );
    } else {
      setActionError(null);
      setSecretOutcomes((current) => new Map(current).set(requestId, "provided"));
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
  };

  const onDecideConnectionApproval = async (
    approvalId: string,
    decision: "approved" | "denied",
  ) => {
    const error = await connectionApprovals.decide(approvalId, decision);
    setActionError(error);
  };

  // Declining. The server cancels the request and fails the task that asked,
  // so the chat stops waiting and the Tasks "Waiting" tab loses the row.
  const onDeclineSecret = async (requestId: string) => {
    if (environmentId === null) return;
    setRespondingIds((current) => new Set(current).add(requestId));
    const result = await cancelSecret({
      environmentId,
      input: { requestId: PersonalSecretRequestId.make(requestId) },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setActionError(
        error instanceof Error ? error.message : "Couldn't decline this request. Try again.",
      );
    } else {
      setActionError(null);
      setSecretOutcomes((current) => new Map(current).set(requestId, "declined"));
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
  };

  const onArchive = async () => {
    if (environmentId === null) return;
    const result = await archiveThread({ environmentId, input: { threadId, archived: true } });
    const failure = commandFailureMessage(result, "Couldn't archive this chat. Try again.");
    if (failure !== null) {
      // The menu has already closed, so the transcript's alert is the only
      // place left to say the chat is still here.
      setActionError(failure);
      return;
    }
    setActionError(null);
    await navigate({ to: "/bots/$botId", params: { botId }, replace: true });
  };

  // Pin, snooze and mark unread: the same server path as the chat list's own actions, for this one
  // chat. Snooze and Mark unread then leave the chat the way Back does (Team origin returns to Team).
  const runChatAction = useBulkChatActions(environmentId);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const pinned = link !== null && isChatPinned(link);
  const onPinChange = async () => {
    setActionError(null);
    const outcome = await runChatAction(pinned ? "unpin" : "pin", [threadId], 0);
    if (outcome.status === "settled" && outcome.anyFailed) setActionError(outcome.notice);
  };
  const leaveAfter = async (
    action: "snooze" | "markUnread",
    options?: { snoozeUntilMs: number },
  ) => {
    setActionError(null);
    const outcome = await runChatAction(action, [threadId], 0, options);
    if (outcome.status === "settled" && outcome.anyFailed) {
      setActionError(outcome.notice);
      return;
    }
    await navigate({ to: backTarget.to, replace: true });
  };

  const [unarchiving, setUnarchiving] = useState(false);
  /** Stays on the chat: the shell clears its archivedAt and the composer comes back. */
  const onUnarchive = async () => {
    if (environmentId === null) return;
    setUnarchiving(true);
    setActionError(null);
    const result = await archiveThread({ environmentId, input: { threadId, archived: false } });
    setUnarchiving(false);
    setActionError(commandFailureMessage(result, "Couldn't unarchive this chat. Try again."));
  };

  const { send: sendWrapup, sending: wrapupSending } = useWrapupChat(
    environmentId,
    thread,
    botTurnModel,
  );
  const onWrapup = async () => {
    const started = await sendWrapup();
    if (!started) setActionError("Couldn't start the wrapup. Try again.");
  };

  const deleteChat = useDeleteChat(environmentId);
  const onDeleteChat = async () => {
    const outcome = await deleteChat(threadId);
    if (outcome.status === "failed") {
      // Confirm has closed the dialog and the chat is still here: without this
      // the only feedback is a console warning, so the user taps Confirm again.
      setActionError(outcome.message);
      return;
    }
    if (outcome.status === "cancelled") return;
    setActionError(null);
    await navigate({ to: "/bots/$botId", params: { botId }, replace: true });
  };

  const renameChat = useRenameChat(environmentId);
  const [renameOpen, setRenameOpen] = useState(false);
  const chatTitle = threadShell?.title ?? thread?.title;

  // Chat chips: the owner's other chats with this bot, one tap away in the
  // header. They need two or more chips; with one chat the header stays as it was.
  const allShells = useThreadShells();
  const relayThreadIds = usePersonalGroupRelayThreadIds(environmentId);
  const chatSeen = useChatSeenState();
  // A snooze that runs out while this screen is open puts its chat back in the chips.
  const wakeClock = useSnoozeWakeClock(list.data?.threads, list.refresh);
  const chipModel = useMemo(
    () =>
      list.data === null
        ? null
        : buildChatChips({
            botId,
            currentThreadId: threadIdParam,
            links: list.data.threads,
            shells: allShells.filter((shell) => shell.environmentId === environmentId),
            relayThreadIds,
            tasks,
            waitingLabels,
            seen: chatSeen,
            nowMs: wakeClock,
          }),
    [
      wakeClock,
      allShells,
      botId,
      chatSeen,
      environmentId,
      list.data,
      relayThreadIds,
      tasks,
      threadIdParam,
      waitingLabels,
    ],
  );
  const chipsShown = bot !== null && chipModel !== null && chipModel.visible;
  useEffect(() => {
    rememberChipsShown(botId, chipsShown);
  }, [botId, chipsShown]);
  // Another chat finishing a turn lights its chip: refetch the list (it carries
  // the unread flag), debounced, as the bot's chat list does.
  useRefetchOnTurnsSettled(chipsShown ? chipModel.turnsKey : "", list.refresh);
  // The server's "switched to the fallback model" and "back on the main model" lines
  // change the bot's label (header, list, tiles): refetch the bots when one lands.
  const fallbackNoticeKey = useMemo(
    () =>
      String(
        messages.filter((message) => readChatNotice(message)?.notice.startsWith("model-fallback-"))
          .length,
      ),
    [messages],
  );
  useRefetchOnTurnsSettled(fallbackNoticeKey, list.refresh);
  // The "+" chip swaps this chat for the new one and keeps Back where it was.
  const onChipNewChat = () =>
    newChat.open({ replace: true, keepState: true, onBeforeStart: markChatSwitched });

  const loadEarlier =
    environmentId !== null && threadHasOlderTurns(threadState)
      ? {
          loading: threadState.page._tag === "Some" && threadState.page.value.loadingOlder,
          onLoad: () => {
            requestOlderThreadTurns(environmentId, threadId);
          },
        }
      : null;

  const botName = headerName.status === "ready" ? headerName.name : null;
  // The server retries a transient reply failure (or a vanished provider
  // session) on its own: a neutral notice while it does, a red one with Retry
  // once the failure is final. Never a raw exception in the chat: a plain
  // sentence, the provider's line behind "Details".
  const turnNotice = turnErrorNotice({
    state: conversationState,
    session: thread?.session ?? null,
    lastMessageTurnStarted: retryTarget?.turnStarted ?? null,
  });
  // Offline: sending is blocked and the draft stays in this device's draft store.
  const disabledReason = laptopOffline
    ? connectionPhase === "offline" || connectionPhase === "error"
      ? "Your laptop is offline. This draft is saved on this device and has not been sent."
      : "Connecting to your laptop. Your draft is saved on this device."
    : provider !== null && bot !== null && !provider.available
      ? `${provider.label} can't run right now, so ${bot.name} can't reply. Fix it on your computer or edit the bot.`
      : null;
  // Reply: the quote waits in the composer for this chat; a tapped choice goes
  // out through the composer's own send (`quickSendRef`).
  const [replyState, setReplyState] = useState<{
    readonly threadId: ThreadId;
    readonly quote: PersonalReplyQuote;
  } | null>(null);
  const replyTo = replyState?.threadId === threadId ? replyState.quote : null;
  const onReply = useCallback(
    (quote: PersonalReplyQuote) => setReplyState({ threadId, quote }),
    [threadId],
  );
  const onClearReply = useCallback(() => setReplyState(null), []);
  const quickSendRef = useRef<((text: string) => Promise<boolean>) | null>(null);
  const onChoose = useCallback(
    (text: string) => quickSendRef.current?.(text) ?? Promise.resolve(false),
    [],
  );
  const onStopFromMenu = async () => {
    const error = await onInterrupt();
    if (error !== null) setActionError(error);
  };

  const botMuted = bot !== null && botMuteState(bot, now.getTime()).muted;

  const chat = (
    <div
      ref={shellRef}
      // Pinned: nothing inside may overflow into the page column, which
      // would let the whole chat scroll away (see MessageList).
      className="relative flex h-full min-h-0 flex-col overflow-clip"
      style={{
        paddingBottom: keyboardInset > 0 ? keyboardInset : "max(env(safe-area-inset-bottom), 8px)",
      }}
    >
      {diagnosticsEnabled() ? <DiagnosticsOverlay /> : null}
      <header
        className={cn(
          "personal-column flex shrink-0 items-center gap-3 px-2",
          chipsShown ? "h-[72px]" : "h-16",
        )}
      >
        {/* md+: the bot list is always beside the chat, so Back has nowhere to go. */}
        <Link
          to={backTarget.to}
          activeOptions={{ exact: true }}
          aria-label={backTarget.label}
          className={cn(ICON_BUTTON, "md:hidden")}
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        {bot !== null && chipsShown ? (
          <>
            {/* Chips on: the avatar and the first line are both Edit bot (the
                avatar stays the full-size target), and the chips take line 2. */}
            <Link
              to="/bots/$botId/edit"
              params={{ botId: bot.botId }}
              aria-hidden="true"
              tabIndex={-1}
              className="shrink-0 rounded-full outline-none active:opacity-70"
            >
              <BotAvatar
                shape={bot.avatarShape}
                color={bot.avatarColor}
                size={48}
                label={bot.name}
                motion={motionForConversationState(
                  quiet === null ? conversationState : "idle",
                  turnThinking,
                )}
                comet={perfOptimizationOn("anim-comet")}
                thought="header"
              />
            </Link>
            <div className="flex h-full min-w-0 flex-1 flex-col">
              <Link
                to="/bots/$botId/edit"
                params={{ botId: bot.botId }}
                aria-label={`Edit ${bot.name}${botMuted ? ", notifications muted" : ""}`}
                className="flex h-[31px] min-w-0 shrink-0 items-start rounded-[var(--personal-radius-button)] pt-1.75 outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
              >
                <ConversationHeaderLine
                  name={bot.name}
                  chatTitle={chatTitle}
                  muted={botMuted}
                  contextBadge={contextBadge}
                >
                  {provider !== null || conversationState !== "idle" ? (
                    <ConversationSubtitle
                      state={conversationState}
                      modelLabel={headerModelLabel}
                      modelNote={headerModelNote}
                      status={headerStatus}
                      quiet={quiet}
                    />
                  ) : null}
                </ConversationHeaderLine>
              </Link>
              <ChatChips
                botId={botId}
                botName={bot.name}
                chips={chipModel.chips}
                openCount={chipModel.openCount}
                onNewChat={onChipNewChat}
              />
            </div>
          </>
        ) : bot !== null ? (
          <Link
            to="/bots/$botId/edit"
            params={{ botId: bot.botId }}
            aria-label={`Edit ${bot.name}${botMuted ? ", notifications muted" : ""}`}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-4 rounded-[var(--personal-radius-button)] outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <BotAvatar
              shape={bot.avatarShape}
              color={bot.avatarColor}
              size={48}
              label={bot.name}
              motion={motionForConversationState(
                quiet === null ? conversationState : "idle",
                turnThinking,
              )}
              comet={perfOptimizationOn("anim-comet")}
              thought="header"
            />
            <div className="min-w-0 flex-1">
              <ConversationHeaderName
                name={bot.name}
                chatTitle={chatTitle}
                muted={botMuted}
                contextBadge={contextBadge}
              />
              {provider !== null || conversationState !== "idle" ? (
                <ConversationSubtitle
                  state={conversationState}
                  modelLabel={headerModelLabel}
                  modelNote={headerModelNote}
                  status={headerStatus}
                  quiet={quiet}
                />
              ) : null}
            </div>
          </Link>
        ) : (
          <>
            {headerName.status === "loading" ? (
              <span
                aria-hidden="true"
                className="size-12 shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              {headerName.status === "loading" ? (
                <>
                  <h1 className="sr-only">Loading chat</h1>
                  <span
                    aria-hidden="true"
                    className="block h-5 w-32 max-w-full rounded-md bg-[var(--personal-fill-muted)]"
                  />
                </>
              ) : (
                <h1 className="truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
                  {headerName.name}
                </h1>
              )}
              {provider !== null || conversationState !== "idle" ? (
                <ConversationSubtitle
                  state={conversationState}
                  modelLabel={null}
                  status={headerStatus}
                />
              ) : null}
            </div>
          </>
        )}
        {sidePanelFits ? (
          <button
            type="button"
            aria-label="Computer and routines panel"
            aria-expanded={sidePanelOpen}
            aria-controls={sidePanelOpen ? CONVERSATION_SIDE_PANEL_ID : undefined}
            onClick={() => setPersonalPreference("showChatSidePanel", !sidePanelOpen)}
            className={cn(
              ICON_BUTTON,
              "text-[var(--personal-text-secondary)]",
              chipsShown && "mt-0.5 self-start",
            )}
          >
            {sidePanelOpen ? (
              <PanelRightClose aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
            ) : (
              <PanelRightOpen aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
            )}
          </button>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Chat options"
                className={cn(ICON_BUTTON, chipsShown && "mt-0.5 self-start")}
              />
            }
          >
            <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </MenuTrigger>
          <MenuPopup align="end" className="personal-app personal-menu min-w-48">
            {interruptInput !== null ? (
              <MenuItem onClick={() => void onStopFromMenu()}>Stop</MenuItem>
            ) : null}
            {bot !== null && providerWait ? (
              <MenuItem
                onClick={() =>
                  void navigate({ to: "/bots/$botId/edit", params: { botId: bot.botId } })
                }
              >
                Switch model…
              </MenuItem>
            ) : null}
            {interruptInput !== null || (bot !== null && providerWait) ? <MenuSeparator /> : null}
            {bot !== null ? (
              <MenuItem disabled={newChat.starting} onClick={() => newChat.open()}>
                New chat
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => void navigate({ to: "/bots/$botId", params: { botId } })}>
              All chats
              {environmentId !== null && list.data !== null ? (
                <AllChatsCount
                  environmentId={environmentId}
                  botId={botId}
                  links={list.data.threads}
                />
              ) : null}
            </MenuItem>
            <MenuItem
              disabled={
                archived || disabledReason !== null || turnBusy || wrapupSending || thread === null
              }
              onClick={() => void onWrapup()}
            >
              Wrapup chat
            </MenuItem>
            {!archived ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void onPinChange()}>
                  {pinned ? "Unpin chat" : "Pin chat"}
                </MenuItem>
                <MenuItem onClick={() => setSnoozeOpen(true)}>Snooze…</MenuItem>
                <MenuItem onClick={() => void leaveAfter("markUnread")}>Mark unread</MenuItem>
              </>
            ) : null}
            {bot !== null ? (
              <>
                <MenuSeparator />
                <BotMuteMenuItems
                  bot={bot}
                  now={now.getTime()}
                  onChange={(mute) => void setBotMute(bot, mute)}
                />
              </>
            ) : null}
            <MenuSeparator />
            <MenuItem disabled={thread === null} onClick={() => setRenameOpen(true)}>
              Rename chat
            </MenuItem>
            {archived ? (
              <MenuItem disabled={unarchiving} onClick={() => void onUnarchive()}>
                Unarchive chat
              </MenuItem>
            ) : (
              <MenuItem onClick={() => void onArchive()}>Archive chat</MenuItem>
            )}
            <MenuItem variant="destructive" onClick={() => void onDeleteChat()}>
              Delete chat
            </MenuItem>
          </MenuPopup>
        </Menu>
      </header>
      {newChat.dialog}
      {snoozeOpen ? (
        <SnoozeSheet
          title="Snooze chat"
          onPick={(untilMs) => {
            setSnoozeOpen(false);
            void leaveAfter("snooze", { snoozeUntilMs: untilMs });
          }}
          onCancel={() => setSnoozeOpen(false)}
        />
      ) : null}
      <RenameChatDialog
        open={renameOpen}
        initialTitle={renameChatInitialTitle(chatTitle)}
        onOpenChange={setRenameOpen}
        onSave={(title) => renameChat(threadId, title)}
      />

      {quiet === null ? (
        <ProgressNoteLine note={progressNote} />
      ) : (
        <QuietNoticeLine notice={quiet} />
      )}

      {thread !== null && environmentId !== null && threadRef !== null ? (
        <>
          <MessageList
            environmentId={environmentId}
            threadRef={threadRef}
            showContextUsed
            items={items}
            pending={visiblePending}
            latestMessageStatus={latestMessageStatus}
            working={working}
            botName={botName ?? "Bot"}
            workspaceRoot={thread.worktreePath ?? project?.workspaceRoot}
            approvals={approvals}
            respondingIds={respondingIds}
            approvalRespondingIds={connectionApprovals.respondingIds}
            onDecideLeadBotChange={leadBotChanges.decide}
            leadBotChangeRespondingIds={leadBotChanges.respondingIds}
            onDecideMemoryChange={memoryChanges.decide}
            memoryChangeRespondingIds={memoryChanges.respondingIds}
            memoryBotName={memoryChanges.botName}
            onRespondToApproval={(requestId, decision) =>
              void onRespondToApproval(requestId, decision)
            }
            onAnswerQuestion={(requestId, answers) => void onAnswerQuestion(requestId, answers)}
            onDismissQuestion={(requestId) => void onDismissQuestion(requestId)}
            onProvideSecret={(...args) => void onProvideSecret(...args)}
            onDeclineSecret={(requestId) => void onDeclineSecret(requestId)}
            onProvideLogin={loginRequests.provide}
            onCancelLogin={(requestId) => void loginRequests.cancel(requestId)}
            onDecideConnectionApproval={(approvalId, decision) =>
              void onDecideConnectionApproval(approvalId, decision)
            }
            approvalsNowMs={now.getTime()}
            errorText={actionError ?? turnNotice?.message ?? null}
            errorDetail={actionError === null ? (turnNotice?.detail ?? null) : null}
            errorTone={actionError === null ? (turnNotice?.tone ?? "danger") : "danger"}
            errorRetry={
              turnNotice?.canRetry === true && !turnBusy && !archived
                ? {
                    onRetry: () => {
                      void failedTurnRetry.retry().then((ok) => {
                        setActionError(ok ? null : "Couldn't retry that message. Try again.");
                      });
                    },
                    busy: failedTurnRetry.busy,
                  }
                : null
            }
            loadEarlier={loadEarlier}
            now={now}
            describeTurn={describeTurn}
            renderDelegation={renderDelegation}
            readOnly={archived}
            onReply={archived ? undefined : onReply}
            onChoose={archived ? undefined : onChoose}
            choicesBusy={turnBusy || disabledReason !== null}
          />
          <ConversationDesktopLine
            environmentId={environmentId}
            status={desktopStatus}
            threadId={threadId}
          />
          {sidePanelOpen ? null : (
            <ConversationComputerLink
              status={computerFeed.status}
              botId={botId}
              threadId={threadId}
              agentTurnRunning={conversationState === "working"}
            />
          )}
          {showRoutinesStrip &&
          conversationState !== "needs_help" &&
          !sidePanelOpen &&
          !archived ? (
            <ConversationRoutinesPanel
              environmentId={environmentId}
              botId={botId}
              onHide={() => setPersonalPreference("showRoutinesStrip", false)}
            />
          ) : null}
          {archived ? (
            <ArchivedChatBar
              hint="Unarchive to send messages again."
              unarchiving={unarchiving}
              disabled={laptopOffline}
              onUnarchive={() => void onUnarchive()}
              onDelete={() => void onDeleteChat()}
            />
          ) : (
            <PersonalComposer
              // One composer per chat: its in-flight send, error and queued
              // state belong to the chat it was sent from.
              key={threadId}
              environmentId={environmentId}
              threadId={threadId}
              thread={thread}
              botName={botName}
              botModelSelection={botTurnModel}
              disabledReason={disabledReason}
              working={turnBusy}
              queuedNotice={false}
              canInterrupt={interruptInput !== null}
              onInterrupt={onInterrupt}
              onPendingChange={(update) => setPending((current) => update(current))}
              replyTo={replyTo}
              onClearReply={onClearReply}
              quickSendRef={quickSendRef}
            />
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[15px] text-[var(--personal-text-secondary)]">
          {environmentId === null ? (
            <p>
              Not connected to your computer yet.{" "}
              <Link
                to="/settings/connections"
                className="font-medium text-[var(--personal-text)] underline"
              >
                Open Connections
              </Link>
            </p>
          ) : loadProblem !== null ? (
            <ChatLoadProblem
              problem={loadProblem}
              missingText="This chat no longer exists."
              errorText="Couldn't load this chat."
              back={
                <Link
                  to="/bots/$botId"
                  activeOptions={{ exact: true }}
                  params={{ botId }}
                  className={CHAT_PROBLEM_BUTTON}
                >
                  {bot === null ? "Back to Bots" : `${bot.name}'s chats`}
                </Link>
              }
              onRetry={retryThread}
            />
          ) : (
            <p aria-live="polite">Loading chat</p>
          )}
        </div>
      )}
    </div>
  );

  // The phone and narrower desktops get the chat exactly as before. Where the
  // panel fits the chat is wrapped whether or not the panel is open, so the
  // toggle never remounts the transcript (scroll position, composer focus).
  if (!sidePanelFits) return chat;
  return (
    <div className="flex h-full min-h-0">
      <div className="h-full min-w-0 flex-1">{chat}</div>
      {sidePanelOpen ? (
        <ConversationSidePanel
          environmentId={environmentId}
          botId={botId}
          threadId={threadId}
          showRoutines={showRoutinesStrip}
          onHideRoutines={() => setPersonalPreference("showRoutinesStrip", false)}
        />
      ) : null}
    </div>
  );
}
