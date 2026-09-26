import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import {
  MessageId,
  PersonalGroupId,
  PersonalGroupVoteId,
  ThreadId,
  type PersonalBot,
  type PersonalBotId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn, randomUUID } from "~/lib/utils";
import { deriveTimelineEntriesWithState, type TimelineEntriesProjection } from "~/session-logic";
import { useThreadDetail, useThreadShells, useThreadStatus } from "~/state/entities";
import { useEnvironmentThread } from "~/state/threads";
import type { ChatMessage } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import { buildConversationItems } from "./conversationModel";
import { commandFailureMessage } from "./commandFeedback";
import { GroupAvatarCluster } from "./GroupAvatarCluster";
import { GroupDeleteSheet } from "./GroupDeleteSheet";
import { GroupSettingsSheet, type GroupMembersActions } from "./GroupSettingsSheet";
import { GroupRoundCard } from "./GroupRoundCard";
import { GroupVoteCard } from "./GroupVoteCard";
import {
  activeGroupMembers,
  groupDeleteCandidates,
  groupMemberThreadIds,
  groupRoundCard,
  groupVoteCard,
  groupStatusLine,
  groupSubtitle,
  isGroupRoundLive,
  reusablePrivateChat,
  roundForGroup,
} from "./groupModel";
import {
  MessageList,
  type GroupSpeakerPresentation,
  type PendingOutgoingMessage,
} from "./MessageList";
import { PersonalComposer } from "./PersonalComposer";
import { useKeyboardInset } from "./useKeyboardInset";
import { useLaptopOffline, usePersonalConnectionPhase } from "./PersonalOfflineBanner";
import { useReportViewingThread } from "./useReportViewingThread";
import { pendingForThread } from "./pendingOutgoing";
import { useCloseGroupNotifications } from "./staleNotifications";
import {
  personalBotCreateThread,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";
import {
  mergePersonalGroups,
  personalGroupAddMember,
  personalGroupContinueRound,
  personalGroupDelete,
  personalGroupRemoveMember,
  personalGroupSendMessage,
  personalGroupStop,
  personalGroupUpdate,
  usePersonalGroupsFeed,
  usePersonalGroupsList,
} from "./usePersonalGroups";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_PLANS: ReadonlyArray<never> = [];
const EMPTY_WORK: ReadonlyArray<never> = [];
const EMPTY_PENDING: ReadonlyArray<PendingOutgoingMessage> = [];
const NO_APPROVALS: ReadonlyArray<never> = [];
const NO_RESPONDING: ReadonlySet<string> = new Set();
const NO_MEMBERS: ReadonlyArray<never> = [];

function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * /bots/groups/$groupId — a sibling of `ConversationScreen`, not a variant of
 * it. Everything that makes a chat a chat is shared and unchanged: the thread
 * detail stream, `deriveTimelineEntriesWithState`, `buildConversationItems`,
 * `MessageList`, `PersonalComposer`, `useKeyboardInset` and paging. What
 * differs is only what a group actually is — several speakers in one
 * transcript, a round instead of a turn, and no provider session of its own.
 *
 * The group thread runs no provider (§1.1), so there is nothing here for
 * approvals, questions, secrets, tool steps or the shared browser: those all
 * happen inside a member's own chat, one tap away through its name.
 */
/* oxlint-disable react/preserve-manual-memoization -- The group and round
   arrays come out of `mergePersonalGroups`, across a module boundary, so the
   compiler cannot prove they are never mutated and bails out of optimising the
   whole component. They are frozen at the source and nothing here writes to
   them. The manual memos stay because they ARE required for semantics: a fresh
   `threadRef` object every render would make `useThreadDetail` resubscribe on
   every keystroke. */
export function GroupConversationScreen({
  groupId,
  openSettings = false,
}: {
  groupId: string;
  /** From `?settings=members`: land with the settings open (Back from a member's editor). */
  openSettings?: boolean;
}): JSX.Element {
  const navigate = useNavigate();
  const environmentId = usePersonalEnvironmentId();
  // The group is on screen: its "round finished" notification is read.
  useCloseGroupNotifications(groupId);
  const groupsQuery = usePersonalGroupsList(environmentId);
  const { feed } = usePersonalGroupsFeed(environmentId);
  const { groups, rounds, votes } = useMemo(
    () => mergePersonalGroups(groupsQuery.data ?? null, feed ?? null),
    [groupsQuery.data, feed],
  );
  const group = groups.find((candidate) => candidate.groupId === groupId) ?? null;
  const round = roundForGroup(rounds, groupId);
  const botsList = usePersonalBotsList(environmentId);

  const threadId = group === null ? null : ThreadId.make(group.threadId);
  const threadRef = useMemo(
    () =>
      environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const threadState = useEnvironmentThread(environmentId, threadId);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useKeyboardInset(shellRef);
  const now = useMinuteNow();
  const [pending, setPending] = useState<ReadonlyArray<PendingOutgoingMessage>>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(openSettings);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const laptopOffline = useLaptopOffline();
  const connectionPhase = usePersonalConnectionPhase();
  useReportViewingThread(
    environmentId,
    threadId ?? ThreadId.make("none"),
    threadId !== null && connectionPhase === "connected",
  );

  const sendMessage = useAtomCommand(personalGroupSendMessage, { reportFailure: false });
  const continueRound = useAtomCommand(personalGroupContinueRound, { reportFailure: false });
  const stopRound = useAtomCommand(personalGroupStop, { reportFailure: false });
  const updateGroup = useAtomCommand(personalGroupUpdate, { reportFailure: false });
  const deleteGroup = useAtomCommand(personalGroupDelete, { reportFailure: false });
  const addMember = useAtomCommand(personalGroupAddMember, { reportFailure: false });
  const removeMember = useAtomCommand(personalGroupRemoveMember, { reportFailure: false });
  const createThread = useAtomCommand(personalBotCreateThread, { reportFailure: false });
  const allShells = useThreadShells();

  const botsById = useMemo(
    () =>
      new Map((botsList.data?.bots ?? []).map((entry) => [entry.botId as string, entry] as const)),
    [botsList.data],
  );
  const nameOf = useCallback((botId: string) => botsById.get(botId)?.name ?? null, [botsById]);
  // At most six entries, so deriving it every render costs nothing.
  const members = group === null ? NO_MEMBERS : activeGroupMembers(group);
  const memberBots = useMemo(
    () =>
      (group === null ? NO_MEMBERS : activeGroupMembers(group)).flatMap((member): PersonalBot[] => {
        const bot = botsById.get(member.botId);
        return bot === undefined ? [] : [bot];
      }),
    [botsById, group],
  );
  // One presentation object per bot, rebuilt only when the roster or the group
  // changes. `groupSpeaker` used to build a fresh object per call, so every
  // group message row's `speaker` prop changed on every render (every stream
  // delta) and the `GroupMessage` memo never held.
  const speakersById = useMemo(() => {
    const threadByBot = new Map(
      (group === null ? NO_MEMBERS : activeGroupMembers(group)).map(
        (member) => [member.botId as string, member.threadId] as const,
      ),
    );
    return new Map(
      [...botsById.values()].map((bot): readonly [string, GroupSpeakerPresentation] => [
        bot.botId as string,
        {
          name: bot.name,
          avatarShape: bot.avatarShape,
          avatarColor: bot.avatarColor,
          threadId: threadByBot.get(bot.botId as string) ?? null,
        },
      ]),
    );
  }, [botsById, group]);
  const groupSpeaker = useCallback(
    (botId: string): GroupSpeakerPresentation | null => speakersById.get(botId) ?? null,
    [speakersById],
  );
  const mentionCandidates = useMemo(
    () =>
      memberBots.map((bot) => ({
        botId: bot.botId as string,
        name: bot.name,
        avatarShape: bot.avatarShape,
        avatarColor: bot.avatarColor,
      })),
    [memberBots],
  );

  // Which members the Delete group sheet ticks by default, and why not.
  const deleteCandidates = useMemo(
    () =>
      group === null
        ? NO_MEMBERS
        : groupDeleteCandidates({ group, groups, bots: botsList.data?.bots ?? [] }),
    [group, groups, botsList.data],
  );

  const messages = (thread?.messages as ReadonlyArray<ChatMessage> | undefined) ?? EMPTY_MESSAGES;
  const projectionRef = useRef<{
    threadId: string;
    projection: TimelineEntriesProjection;
  } | null>(null);
  /* oxlint-disable react/refs -- Pure render cache, as in ConversationScreen:
     it holds only the last projection for the last thread, and dropping it
     costs a re-fold, never a different result. */
  const items = useMemo(() => {
    const key = threadId ?? "none";
    const previous = projectionRef.current;
    const projection = deriveTimelineEntriesWithState(
      messages,
      EMPTY_PLANS,
      EMPTY_WORK,
      previous?.threadId === key ? previous.projection : null,
    );
    projectionRef.current = { threadId: key, projection };
    // The group thread runs no provider, so there are no tool steps to show and
    // `groups` is what turns each message into its speaker's row.
    return buildConversationItems(projection.entries, { groups: true });
  }, [messages, threadId, projectionRef]);
  /* oxlint-enable react/refs */

  const live = isGroupRoundLive(round);
  const stateLabel = groupStatusLine(round, nameOf);
  const card = groupRoundCard(round, nameOf);
  // `groupRoundCard` returns null for `paused_vote` and this returns null for
  // everything else, so exactly one card can ever be in the slot below.
  const vote = groupVoteCard({ round, votes, members, nameOf });

  const visiblePending = useMemo(
    () => (threadId === null ? EMPTY_PENDING : pendingForThread(pending, threadId, messages)),
    [messages, pending, threadId],
  );

  const send = useCallback(
    async (input: { readonly messageId: string; readonly text: string }) => {
      if (environmentId === null) return { _tag: "Failure" as const };
      return sendMessage({
        environmentId,
        input: {
          groupId: PersonalGroupId.make(groupId),
          messageId: MessageId.make(input.messageId),
          text: input.text,
        },
      });
    },
    [environmentId, groupId, sendMessage],
  );

  const onStop = useCallback(async (): Promise<string | null> => {
    if (environmentId === null) return null;
    // Stops every member, not just the one speaking: a group's Stop that left
    // the queue running would be a lie.
    const result = await stopRound({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId) },
    });
    return commandFailureMessage(result, "Couldn't stop the group. Try again.");
  }, [environmentId, groupId, stopRound]);

  const onContinue = useCallback(async (): Promise<string | null> => {
    if (environmentId === null) return null;
    const result = await continueRound({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId) },
    });
    return commandFailureMessage(result, "Couldn't continue the group. Try again.");
  }, [continueRound, environmentId, groupId]);

  const voteId = vote?.voteId ?? null;
  /**
   * The owner's answer to a tally. The same RPC as Continue, because it is the
   * same act: a parked round only ever moves because the owner said so. Until
   * this runs, nothing the bots agreed on has reached any of them.
   */
  const onDecide = useCallback(
    async (decision: "approve" | "reject"): Promise<string | null> => {
      if (environmentId === null || voteId === null) return null;
      const result = await continueRound({
        environmentId,
        input: {
          groupId: PersonalGroupId.make(groupId),
          vote: { voteId: PersonalGroupVoteId.make(voteId), decision },
        },
      });
      return commandFailureMessage(
        result,
        decision === "approve"
          ? "Couldn't approve that. Try again."
          : "Couldn't reject that. Try again.",
      );
    },
    [continueRound, environmentId, groupId, voteId],
  );

  const onArchive = async () => {
    if (environmentId === null) return;
    const result = await updateGroup({
      environmentId,
      input: { groupId: PersonalGroupId.make(groupId), archived: true },
    });
    const failure = commandFailureMessage(result, "Couldn't archive this group. Try again.");
    if (failure !== null) {
      setActionError(failure);
      return;
    }
    await navigate({ to: "/bots", replace: true });
  };

  /**
   * Only the bots the owner ticked are named, and the server refuses any id
   * that is not a current member - so a sheet built from a stale list can never
   * destroy a bot that is no longer on screen.
   */
  const onDelete = async (purgeBotIds: ReadonlyArray<string>) => {
    if (environmentId === null) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await deleteGroup({
      environmentId,
      input: {
        groupId: PersonalGroupId.make(groupId),
        purgeBotIds: purgeBotIds.map((botId) => botId as PersonalBotId),
      },
    });
    const failure = commandFailureMessage(result, "Couldn't delete this group. Try again.");
    setDeleting(false);
    if (failure !== null) {
      // The sheet stays open: the group survives a failed purge (see
      // `deletePersonalGroup`), so this is a state the owner can act on.
      setDeleteError(failure);
      return;
    }
    setDeleteOpen(false);
    await navigate({ to: "/bots", replace: true });
  };

  const offlineMessage = "Not connected to your computer.";
  const memberActions: GroupMembersActions = {
    onEditBot: (botId) =>
      void navigate({
        to: "/bots/$botId/edit",
        params: { botId: botId as PersonalBotId },
        search: { group: groupId },
      }),
    onNewBot: () => void navigate({ to: "/bots/new", search: { group: groupId } }),
    onAddMember: async (botId) => {
      if (environmentId === null) return offlineMessage;
      const result = await addMember({
        environmentId,
        input: { groupId: PersonalGroupId.make(groupId), botId: botId as PersonalBotId },
      });
      return commandFailureMessage(result, "Couldn't add that bot. Try again.");
    },
    onRemoveMember: async (botId) => {
      if (environmentId === null) return offlineMessage;
      const result = await removeMember({
        environmentId,
        input: { groupId: PersonalGroupId.make(groupId), botId: botId as PersonalBotId },
      });
      return commandFailureMessage(result, "Couldn't remove that bot. Try again.");
    },
    /**
     * Opens the bot's private chat: an empty one it already has (an earlier
     * tap never written in), else a new one. The bot joins the Bots list once
     * that chat has a message in it.
     */
    onMessagePrivately: async (botId) => {
      if (environmentId === null) return offlineMessage;
      const reuse = reusablePrivateChat({
        botId,
        links: botsList.data?.threads ?? [],
        shells: allShells.filter((shell) => shell.environmentId === environmentId),
        relayThreadIds: groupMemberThreadIds(groups),
      });
      let threadId = reuse === null ? null : ThreadId.make(reuse);
      if (threadId === null) {
        const fresh = ThreadId.make(randomUUID());
        const result = await createThread({
          environmentId,
          input: { botId: botId as PersonalBotId, threadId: fresh },
        });
        const failure = commandFailureMessage(result, "Couldn't start a private chat. Try again.");
        if (failure !== null) return failure;
        threadId = fresh;
      }
      setShowSettings(false);
      await navigate({
        to: "/bots/$botId/$threadId",
        params: { botId: botId as PersonalBotId, threadId },
      });
      return null;
    },
  };

  const loadEarlier =
    environmentId !== null && threadId !== null && threadHasOlderTurns(threadState)
      ? {
          loading: threadState.page._tag === "Some" && threadState.page.value.loadingOlder,
          onLoad: () => {
            requestOlderThreadTurns(environmentId, threadId);
          },
        }
      : null;

  const disabledReason = laptopOffline
    ? connectionPhase === "offline" || connectionPhase === "error"
      ? "Your laptop is offline. This draft is saved on this device and has not been sent."
      : "Connecting to your laptop. Your draft is saved on this device."
    : members.length === 0
      ? "This group has no bots in it yet. Add one in Group settings."
      : null;

  return (
    <div
      ref={shellRef}
      className="flex h-full min-h-0 flex-col"
      style={{
        paddingBottom: keyboardInset > 0 ? keyboardInset : "max(env(safe-area-inset-bottom), 8px)",
      }}
    >
      <header className="personal-column flex h-16 shrink-0 items-center gap-3 px-2">
        {/* md+: the bot list is always beside the chat, so Back has nowhere to go. */}
        <Link to="/bots" aria-label="Back to Bots" className={cn(ICON_BUTTON, "md:hidden")}>
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-haspopup="dialog"
          aria-label={group === null ? undefined : `${group.name} settings`}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-[var(--personal-radius-button)] text-left outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <GroupAvatarCluster bots={memberBots} memberCount={members.length} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
              {group?.name ?? (groupsQuery.data === null ? "Loading group" : "Group")}
            </span>
            {group !== null ? (
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    live
                      ? "bg-[var(--personal-live)]"
                      : stateLabel.tone === "review"
                        ? "bg-[var(--personal-review)]"
                        : "bg-[var(--personal-text-tertiary)]",
                  )}
                />
                {/* No flex-1: on the phone it pushed the state away from the
                    members across a gap; now it follows them, as in a bot chat. */}
                <span className="min-w-0 truncate">{groupSubtitle(group, nameOf)}</span>
                <span className="shrink-0 whitespace-nowrap">· {stateLabel.label}</span>
              </span>
            ) : null}
          </span>
        </button>
        <Menu>
          <MenuTrigger
            render={<button type="button" aria-label="Group options" className={ICON_BUTTON} />}
          >
            <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </MenuTrigger>
          <MenuPopup align="end" className="personal-app personal-menu min-w-48">
            <MenuItem onClick={() => setShowSettings(true)}>Group settings…</MenuItem>
            {live ? (
              <MenuItem
                onClick={() => {
                  void onStop().then(setActionError);
                }}
              >
                Stop
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem onClick={() => void onArchive()}>Archive group</MenuItem>
            <MenuItem
              variant="destructive"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete group
            </MenuItem>
          </MenuPopup>
        </Menu>
      </header>

      {group !== null && thread !== null && environmentId !== null && threadRef !== null ? (
        <>
          <MessageList
            environmentId={environmentId}
            threadRef={threadRef}
            items={items}
            pending={visiblePending}
            working={live}
            botName={group.name}
            workspaceRoot={undefined}
            approvals={NO_APPROVALS}
            respondingIds={NO_RESPONDING}
            onRespondToApproval={() => undefined}
            onAnswerQuestion={() => undefined}
            onDismissQuestion={() => undefined}
            onProvideSecret={() => undefined}
            onDeclineSecret={() => undefined}
            // Inert like the secret and question handlers above, and for the
            // same reason: the group thread runs no provider, so a gated call
            // belongs to the member bot's own chat and its card appears there.
            onDecideConnectionApproval={() => undefined}
            approvalRespondingIds={NO_RESPONDING}
            approvalsNowMs={now.getTime()}
            errorText={actionError}
            loadEarlier={loadEarlier}
            now={now}
            describeTurn={() => ""}
            renderDelegation={() => null}
            groupSpeaker={groupSpeaker}
          />
          {vote !== null ? (
            /* The same slot as the round card, and never at the same time as
               one: a parked round is either waiting on a budget or waiting on
               this decision. */
            <div className="shrink-0 px-4 pb-2">
              <GroupVoteCard card={vote} speakerOf={groupSpeaker} onDecide={onDecide} />
            </div>
          ) : null}
          {card !== null ? (
            /* Directly under the transcript and above the composer: the round
               ended at the end of the conversation, so that is where its card
               belongs, and it stays on screen without a scroll. Continue and
               Retry are the same RPC — `continueRound` re-claims a throttled
               round as readily as it spends a fresh budget. */
            <div className="personal-column shrink-0 px-4 pb-2">
              <GroupRoundCard card={card} onAct={onContinue} />
            </div>
          ) : null}
          <PersonalComposer
            key={group.threadId}
            environmentId={environmentId}
            threadId={ThreadId.make(group.threadId)}
            thread={thread}
            botName={group.name}
            disabledReason={disabledReason}
            working={live}
            botLastSpokeAtMs={null}
            canInterrupt={live}
            onInterrupt={onStop}
            onPendingChange={(update) => setPending((current) => update(current))}
            send={send}
            mentionCandidates={mentionCandidates}
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
          ) : groupsQuery.error !== null ? (
            <p role="alert">Couldn't load this group. {groupsQuery.error}</p>
          ) : groupsQuery.data !== null && group === null ? (
            <p>
              This group no longer exists.{" "}
              <Link to="/bots" className="font-medium text-[var(--personal-text)] underline">
                Back to Bots
              </Link>
            </p>
          ) : status === "deleted" ? (
            <p>
              This group's conversation was deleted.{" "}
              <Link to="/bots" className="font-medium text-[var(--personal-text)] underline">
                Back to Bots
              </Link>
            </p>
          ) : (
            <p aria-live="polite">Loading group</p>
          )}
        </div>
      )}

      {showSettings && group !== null ? (
        <GroupSettingsSheet
          group={group}
          groups={groups}
          bots={botsList.data?.bots ?? []}
          actions={memberActions}
          onClose={() => {
            setShowSettings(false);
            // Drop `?settings=members` so a reload lands on the conversation.
            if (openSettings) {
              void navigate({
                to: "/bots/groups/$groupId",
                params: { groupId },
                search: {},
                replace: true,
              });
            }
          }}
        />
      ) : null}

      {deleteOpen ? (
        <GroupDeleteSheet
          groupName={group?.name ?? "this group"}
          candidates={deleteCandidates}
          botsById={botsById}
          busy={deleting}
          error={deleteError}
          onClose={() => setDeleteOpen(false)}
          onConfirm={(botIds) => void onDelete(botIds)}
        />
      ) : null}
    </div>
  );
}
