import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  derivePendingRequests,
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
  PersonalSecretRequestId,
  type ApprovalRequestId,
  type PersonalSecretRequest,
  type PersonalTask,
  type ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { ChevronLeft, Ellipsis } from "lucide-react";

import { buildRunningThreadTurnInterruptInput } from "~/components/ChatView.logic";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import {
  derivePhase,
  deriveTimelineEntriesWithState,
  deriveWorkLogEntries,
  type TimelineEntriesProjection,
} from "~/session-logic";
import { useProject, useThreadDetail, useThreadStatus } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";
import { threadEnvironment, useEnvironmentThread } from "~/state/threads";
import type { ChatMessage } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import { motionForConversationState } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import {
  type ConversationHeaderParts,
  conversationHeaderParts,
  resolveBotProvider,
} from "./botSummaries";
import { commandFailureMessage } from "./commandFeedback";
import { ConversationComputerPanel } from "./ConversationComputerPanel";
import { useComputerFeed } from "./computer/computerState";
import { ConversationRoutinesPanel } from "./ConversationRoutinesPanel";
import {
  botLastSpokeAtMs,
  autoRetryNotice,
  buildConversationItems,
  CONVERSATION_STATE_LABEL,
  type ConversationState,
  conversationStateLabel,
  deriveConversationState,
  friendlyTurnError,
  placeDelegationCards,
  resolveConversationHeaderName,
} from "./conversationModel";
import { DelegationCard } from "./DelegationCard";
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
import {
  personalSecretCancel,
  personalSecretFulfill,
  usePendingSecretRequests,
} from "./useSecretRequests";
import { setPersonalPreference, usePersonalPreference } from "./personalPreferences";
import { diagnosticsEnabled, DiagnosticsOverlay } from "./DiagnosticsOverlay";
import { useKeyboardInset } from "./useKeyboardInset";
import { useReportViewingThread } from "./useReportViewingThread";
import { PersonalComposer } from "./PersonalComposer";
import { useLaptopOffline, usePersonalConnectionPhase } from "./PersonalOfflineBanner";
import { useStartBotChat } from "./startBotChat";
import { usePersonalTasks } from "./usePersonalAutomation";
import {
  personalBotArchiveThread,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";
import { useWrapupChat } from "./wrapupChat";
import { useDeleteChat } from "./useDeleteChat";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

const STATE_DOT: Record<ConversationState, string> = {
  idle: "bg-[var(--personal-text-tertiary)]",
  needs_help: "bg-[var(--personal-review)]",
  working: "bg-[var(--personal-live)]",
  waiting: "bg-[var(--personal-review)]",
  // Parked on another bot's work: not working itself, not needing the user.
  delegating: "bg-[var(--personal-text-tertiary)]",
  rate_limited: "bg-[var(--personal-review)]",
  retrying: "bg-[var(--personal-review)]",
  error: "bg-[#b3261e]",
};

/**
 * Header subtitle: the state dot, the bot's role, then the provider and what
 * the bot is doing. Only the role truncates. The status used to share one
 * truncating span with the provider, so a long role turned "Waiting for you"
 * into "Wait…" - the one part of the line worth reading.
 */
function ConversationSubtitle({
  state,
  title,
  parts,
}: {
  state: ConversationState;
  title: string;
  parts: ConversationHeaderParts;
}): JSX.Element {
  return (
    <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])} />
      {title !== "" ? (
        // The separator truncates with the role: a squeezed role must not
        // leave a lone "·" beside the dot.
        <span className="min-w-0 flex-1 truncate">
          {title}
          <span aria-hidden="true"> ·</span>
        </span>
      ) : null}
      <span className="shrink-0 whitespace-nowrap">
        {parts.prefix === null ? parts.status : `${parts.prefix} · ${parts.status}`}
      </span>
    </p>
  );
}

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
  const status = useThreadStatus(threadRef);

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
  const { start: startNewChat, starting } = useStartBotChat(environmentId, bot?.botId ?? null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useKeyboardInset(shellRef);
  const now = useMinuteNow();
  const [pending, setPending] = useState<ReadonlyArray<PendingOutgoingMessage>>([]);
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [computerPanelVisible, setComputerPanelVisible] = useState(false);
  const [computerPanelExpanded, setComputerPanelExpanded] = useState(false);
  const laptopOffline = useLaptopOffline();
  const connectionPhase = usePersonalConnectionPhase();
  // Reading this chat right now means its own notifications stay off the
  // phone; every other chat still notifies.
  useReportViewingThread(environmentId, threadId, connectionPhase === "connected");
  const { feed: computerFeed } = useComputerFeed(environmentId);

  // Delegation state comes from the live task feed (personalTasks.subscribe).
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const tasks = useMemo(() => (taskFeed === null ? [] : [...taskFeed.values()]), [taskFeed]);
  const botsById = useMemo(
    () => new Map((list.data?.bots ?? []).map((entry) => [entry.botId as string, entry] as const)),
    [list.data],
  );
  const nameOf = useCallback((id: string) => botsById.get(id)?.name ?? null, [botsById]);
  const waitingLabels = useMemo(() => waitingLabelsByThread(tasks, nameOf), [tasks, nameOf]);
  const waitingLabel = waitingLabels.get(threadId) ?? null;
  const children = useMemo(() => delegatedChildren(threadId, tasks), [threadId, tasks]);

  const messages = (thread?.messages as ReadonlyArray<ChatMessage> | undefined) ?? EMPTY_MESSAGES;
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
  const items = useMemo(() => placeDelegationCards(baseItems, children), [baseItems, children]);
  // Read off the items the composer's "Queued" notice is shown over, so the
  // notice retires as soon as the bot answers the steered message.
  const botSpokeAtMs = useMemo(() => botLastSpokeAtMs(baseItems), [baseItems]);
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
          providerLabel={
            childBot === null
              ? null
              : resolveBotProvider(childBot.modelSelection.instanceId, providers).label
          }
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
  const questionCards = useMemo(
    () =>
      deriveQuestionCards(
        userInputs,
        // A thread switch that has not settled yet must not show the previous
        // chat's cards.
        seenUserInputs.threadId === threadId ? seenUserInputs.requests : new Map(),
        deriveUserInputResolutions(activities),
      ),
    [activities, seenUserInputs, threadId, userInputs],
  );
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

  const conversationState = deriveConversationState({
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
    pendingApprovals: approvals,
    pendingUserInputs: userInputs,
    browserStatus: computerFeed.status,
    threadId,
    waitingForAgent: waitingLabel !== null,
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
  const stateLabel =
    conversationState === "delegating"
      ? (waitingLabel ?? CONVERSATION_STATE_LABEL.delegating)
      : conversationStateLabel(conversationState, thread?.session ?? null, now);
  const provider =
    bot === null ? null : resolveBotProvider(bot.modelSelection.instanceId, providers);
  const headerParts = conversationHeaderParts(conversationState, stateLabel, provider);

  // Optimistic rows hide once the server echoes the same client message id.
  const visiblePending = useMemo(() => {
    if (pending.length === 0) return pending;
    const echoed = new Set(messages.map((message) => message.id as string));
    return pending.filter((message) => !echoed.has(message.id));
  }, [messages, pending]);

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
  const onProvideSecret = async (requestId: string, value: string) => {
    if (environmentId === null) return;
    setRespondingIds((current) => new Set(current).add(requestId));
    const result = await fulfillSecret({
      environmentId,
      input: {
        requestId: PersonalSecretRequestId.make(requestId),
        value: Redacted.make(value),
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

  const { send: sendWrapup, sending: wrapupSending } = useWrapupChat(
    environmentId,
    thread,
    bot?.modelSelection ?? null,
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
  const failedOnLimit = conversationState === "rate_limited" && thread?.session?.status === "error";
  // The server retries a transient reply failure on its own. Say so while it
  // waits, and say it gave up once the attempts are spent; either way the
  // provider's own line stays behind "Details".
  const retryNotice = autoRetryNotice(thread?.session?.providerRetry);
  const sessionError =
    conversationState === "error" || failedOnLimit || retryNotice !== null
      ? (thread?.session?.lastError ?? "The last turn failed.")
      : null;
  // Never a raw exception in the chat: a plain sentence, the provider's line behind "Details".
  const sessionErrorInfo = sessionError === null ? null : friendlyTurnError(sessionError);
  // Offline: sending is blocked and the draft stays in this device's draft store.
  const disabledReason = laptopOffline
    ? connectionPhase === "offline" || connectionPhase === "error"
      ? "Your laptop is offline. This draft is saved on this device and has not been sent."
      : "Connecting to your laptop. Your draft is saved on this device."
    : provider !== null && bot !== null && !provider.available
      ? `${provider.label} can't run right now, so ${bot.name} can't reply. Fix it on your computer or edit the bot.`
      : null;
  const onStopFromMenu = async () => {
    const error = await onInterrupt();
    if (error !== null) setActionError(error);
  };

  return (
    <div
      ref={shellRef}
      className="flex h-full min-h-0 flex-col"
      style={{
        paddingBottom: keyboardInset > 0 ? keyboardInset : "max(env(safe-area-inset-bottom), 8px)",
      }}
    >
      {diagnosticsEnabled() ? <DiagnosticsOverlay /> : null}
      <header className="flex h-16 shrink-0 items-center gap-3 px-2">
        <Link to="/bots" aria-label="Back to Bots" className={ICON_BUTTON}>
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        {bot !== null ? (
          <Link
            to="/bots/$botId/edit"
            params={{ botId: bot.botId }}
            aria-label={`Edit ${bot.name}`}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-[var(--personal-radius-button)] outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <BotAvatar
              shape={bot.avatarShape}
              color={bot.avatarColor}
              size={48}
              label={bot.name}
              motion={motionForConversationState(conversationState)}
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
                {bot.name}
              </h1>
              {provider !== null || conversationState !== "idle" ? (
                <ConversationSubtitle
                  state={conversationState}
                  title={bot.title}
                  parts={headerParts}
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
                <ConversationSubtitle state={conversationState} title="" parts={headerParts} />
              ) : null}
            </div>
          </>
        )}
        <Menu>
          <MenuTrigger
            render={<button type="button" aria-label="Chat options" className={ICON_BUTTON} />}
          >
            <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
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
              <MenuItem disabled={starting} onClick={() => void startNewChat()}>
                New chat
              </MenuItem>
            ) : null}
            <MenuItem
              onClick={() => {
                setComputerPanelVisible(true);
                setComputerPanelExpanded(true);
              }}
            >
              Computer
            </MenuItem>
            <MenuItem onClick={() => void navigate({ to: "/bots/$botId", params: { botId } })}>
              All chats
            </MenuItem>
            <MenuItem
              disabled={disabledReason !== null || turnBusy || wrapupSending || thread === null}
              onClick={() => void onWrapup()}
            >
              Wrapup chat
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => void onArchive()}>Archive chat</MenuItem>
            <MenuItem variant="destructive" onClick={() => void onDeleteChat()}>
              Delete chat
            </MenuItem>
          </MenuPopup>
        </Menu>
      </header>

      {thread !== null && environmentId !== null && threadRef !== null ? (
        <>
          <MessageList
            environmentId={environmentId}
            threadRef={threadRef}
            items={items}
            pending={visiblePending}
            working={working}
            botName={botName ?? "Bot"}
            workspaceRoot={thread.worktreePath ?? project?.workspaceRoot}
            approvals={approvals}
            questionCards={questionCards}
            secretRequestCards={secretRequestCards}
            respondingIds={respondingIds}
            onRespondToApproval={(requestId, decision) =>
              void onRespondToApproval(requestId, decision)
            }
            onAnswerQuestion={(requestId, answers) => void onAnswerQuestion(requestId, answers)}
            onDismissQuestion={(requestId) => void onDismissQuestion(requestId)}
            onProvideSecret={(requestId, value) => void onProvideSecret(requestId, value)}
            onDeclineSecret={(requestId) => void onDeclineSecret(requestId)}
            errorText={actionError ?? retryNotice ?? sessionErrorInfo?.message ?? null}
            errorDetail={actionError === null ? (sessionErrorInfo?.detail ?? null) : null}
            loadEarlier={loadEarlier}
            now={now}
            describeTurn={describeTurn}
            renderDelegation={renderDelegation}
          />
          <ConversationComputerPanel
            environmentId={environmentId}
            botId={botId}
            threadId={threadId}
            manuallyVisible={computerPanelVisible}
            expanded={computerPanelExpanded || conversationState === "needs_help"}
            onExpandedChange={(expanded) => {
              if (expanded) setComputerPanelVisible(true);
              setComputerPanelExpanded(expanded);
            }}
            onBrowserClosed={() => {
              setComputerPanelVisible(false);
              setComputerPanelExpanded(false);
            }}
            conversationState={
              conversationState === "working" || conversationState === "needs_help"
                ? conversationState
                : "other"
            }
          />
          {showRoutinesStrip && !computerPanelExpanded && conversationState !== "needs_help" ? (
            <ConversationRoutinesPanel
              environmentId={environmentId}
              botId={botId}
              onHide={() => setPersonalPreference("showRoutinesStrip", false)}
            />
          ) : null}
          <PersonalComposer
            environmentId={environmentId}
            threadId={threadId}
            thread={thread}
            botName={botName}
            botModelSelection={bot?.modelSelection ?? null}
            disabledReason={disabledReason}
            working={turnBusy}
            botLastSpokeAtMs={botSpokeAtMs}
            canInterrupt={interruptInput !== null}
            onInterrupt={onInterrupt}
            onPendingChange={(update) => setPending((current) => update(current))}
          />
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
          ) : status === "deleted" ? (
            <p>
              This chat was deleted.{" "}
              <Link
                to="/bots/$botId"
                params={{ botId }}
                className="font-medium text-[var(--personal-text)] underline"
              >
                See other chats
              </Link>
            </p>
          ) : (
            <p aria-live="polite">Loading chat</p>
          )}
        </div>
      )}
    </div>
  );
}
