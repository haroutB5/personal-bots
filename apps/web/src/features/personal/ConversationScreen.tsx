import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import {
  type ApprovalRequestId,
  type PersonalTask,
  type ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis } from "lucide-react";

import { buildRunningThreadTurnInterruptInput } from "~/components/ChatView.logic";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { derivePhase, deriveTimelineEntries, deriveWorkLogEntries } from "~/session-logic";
import { useProject, useThreadDetail, useThreadStatus } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";
import { threadEnvironment, useEnvironmentThread } from "~/state/threads";
import type { ChatMessage } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { resolveBotProvider } from "./botSummaries";
import {
  buildConversationItems,
  CONVERSATION_STATE_LABEL,
  type ConversationState,
  conversationStateLabel,
  deriveConversationState,
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
import { PersonalComposer } from "./PersonalComposer";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import { useStartBotChat } from "./startBotChat";
import { usePersonalTasks } from "./usePersonalAutomation";
import {
  personalBotArchiveThread,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

const STATE_DOT: Record<ConversationState, string> = {
  idle: "bg-[var(--personal-text-tertiary)]",
  working: "bg-[var(--personal-live)]",
  waiting: "bg-[var(--personal-review)]",
  // Parked on another bot's work: not working itself, not needing the user.
  delegating: "bg-[var(--personal-text-tertiary)]",
  rate_limited: "bg-[var(--personal-review)]",
  retrying: "bg-[var(--personal-review)]",
  error: "bg-[#b3261e]",
};

const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_ACTIVITIES: ReadonlyArray<never> = [];
const EMPTY_PLANS: ReadonlyArray<never> = [];

/**
 * Height the on-screen keyboard covers. Chromium resizes the layout viewport
 * itself (`interactive-widget=resizes-content`), which leaves this at 0; iOS
 * Safari only shrinks the visual viewport, so the composer is lifted by the
 * difference.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(covered > 1 ? Math.round(covered) : 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

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
  const archiveThread = useAtomCommand(personalBotArchiveThread);
  const { start: startNewChat, starting } = useStartBotChat(environmentId, bot?.botId ?? null);
  const keyboardInset = useKeyboardInset();
  const now = useMinuteNow();
  const [pending, setPending] = useState<ReadonlyArray<PendingOutgoingMessage>>([]);
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const laptopOffline = useLaptopOffline();

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
  const baseItems = useMemo(
    () => buildConversationItems(deriveTimelineEntries(messages, proposedPlans, workEntries)),
    [messages, proposedPlans, workEntries],
  );
  const items = useMemo(() => placeDelegationCards(baseItems, children), [baseItems, children]);
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
  const conversationState = deriveConversationState({
    session: thread?.session ?? null,
    latestTurn: thread?.latestTurn ?? null,
    pendingApprovals: approvals,
    pendingUserInputs: userInputs,
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

  const onArchive = async () => {
    if (environmentId === null) return;
    const result = await archiveThread({ environmentId, input: { threadId, archived: true } });
    if (result._tag === "Success") {
      await navigate({ to: "/bots/$botId", params: { botId }, replace: true });
    }
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
  const sessionError =
    conversationState === "error" || failedOnLimit
      ? (thread?.session?.lastError ?? "The last turn failed.")
      : null;
  // Offline: sending is blocked and the draft stays in this device's draft store.
  const disabledReason = laptopOffline
    ? "Your laptop is offline. This draft is saved on this device and has not been sent."
    : provider !== null && bot !== null && !provider.available
      ? `${provider.label} can't run right now, so ${bot.name} can't reply. Fix it on your computer or edit the bot.`
      : null;
  const onStopFromMenu = async () => {
    const error = await onInterrupt();
    if (error !== null) setActionError(error);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{
        paddingBottom: keyboardInset > 0 ? keyboardInset : "max(env(safe-area-inset-bottom), 8px)",
      }}
    >
      <header className="flex h-16 shrink-0 items-center gap-3 px-2">
        <Link to="/bots" aria-label="Back to Bots" className={ICON_BUTTON}>
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        {bot !== null ? (
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={48} label={bot.name} />
        ) : headerName.status === "loading" ? (
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
            <p className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              <span
                aria-hidden="true"
                className={cn("size-2 shrink-0 rounded-full", STATE_DOT[conversationState])}
              />
              {bot !== null && bot.title !== "" ? (
                <>
                  <span className="min-w-0 truncate">{bot.title}</span>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span
                className={
                  providerWait || conversationState === "delegating"
                    ? "min-w-0 truncate"
                    : "shrink-0"
                }
              >
                {provider !== null ? `${provider.label} · ${stateLabel}` : stateLabel}
              </span>
            </p>
          ) : null}
        </div>
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
              <MenuItem
                onClick={() =>
                  void navigate({ to: "/bots/$botId/edit", params: { botId: bot.botId } })
                }
              >
                Edit bot
              </MenuItem>
            ) : null}
            {bot !== null ? (
              <MenuItem disabled={starting} onClick={() => void startNewChat()}>
                New chat
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => void navigate({ to: "/bots/$botId", params: { botId } })}>
              All chats
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => void onArchive()}>Archive chat</MenuItem>
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
            userInputs={userInputs}
            respondingIds={respondingIds}
            onRespondToApproval={(requestId, decision) =>
              void onRespondToApproval(requestId, decision)
            }
            errorText={actionError ?? sessionError}
            loadEarlier={loadEarlier}
            now={now}
            describeTurn={describeTurn}
            renderDelegation={renderDelegation}
          />
          <PersonalComposer
            environmentId={environmentId}
            threadId={threadId}
            thread={thread}
            botName={botName}
            botModelSelection={bot?.modelSelection ?? null}
            disabledReason={disabledReason}
            working={turnBusy}
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
