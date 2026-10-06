import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { botEffectiveModelSelection, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, NotebookPen, Pencil, Plus } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { useThreadDetail, useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { botActiveModelShortLabel, fallbackNoteLabel } from "./botModelLabel";
import { botThreadRows, type BotThreadRow } from "./botThreadRows";
import { usePersonalGroupRelayThreadIds } from "./usePersonalGroups";
import { commandFailureMessage } from "./commandFeedback";
import { isThreadLive, isThreadRateLimited, threadNeedsAttention } from "./botSummaries";
import { formatRelativeTime } from "./relativeTime";
import { useNewChatPrompt } from "./useNewChatPrompt";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import { usePersonalTasks } from "./usePersonalAutomation";
import { useRefreshBotsForTaskThreads } from "./useRefreshBotsForTaskThreads";
import {
  personalBotArchiveThread,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";
import { useWrapupChat } from "./wrapupChat";
import { useDeleteChat } from "./useDeleteChat";
import { SwipeToDelete } from "./SwipeToDelete";
import {
  allChatsSelected,
  type BulkChatAction,
  type ChatSection,
  selectedCountLabel,
  toggleChatSelection,
  visibleSelection,
} from "./chatSelection";
import { useBulkChatActions, type BulkChatOptions } from "./useBulkChatActions";
import { isChatPinned, wakeLabel } from "./chatState";
import { PinMark } from "./PinMark";
import { SnoozeSheet } from "./SnoozeSheet";
import { useSnoozeWakeClock } from "./useSnoozeWakeClock";
import { useLongPress } from "./useLongPress";
import { isChatUnread, useChatSeenState, useRefetchOnTurnsSettled } from "./unreadChats";
import { UnreadDot } from "./UnreadChatsBadge";
import { usePersonalBackTarget } from "./usePersonalBackTarget";
import {
  BulkNoticeLine,
  NO_TOUCH_SELECT,
  SELECT_TEXT_BUTTON,
  SelectCheck,
  SelectModeActions,
  SelectModeDeleteButton,
  SelectModeHeader,
  useBulkNotice,
  useEscapeToExit,
} from "./SelectMode";

/** A snoozed row has nothing to select: it wakes first. */
const ignoreLongPress = () => {};

const ICON_LINK =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/** A row in select mode: the whole row toggles; no swipe, no opening the chat. */
function SelectableThreadRow({
  row,
  now,
  selected,
  onToggle,
  unread = false,
}: {
  row: BotThreadRow;
  now: number;
  selected: boolean;
  onToggle: (threadId: string) => void;
  unread?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={() => onToggle(row.link.threadId)}
        className={cn(
          "flex min-h-14 w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]",
          NO_TOUCH_SELECT,
        )}
      >
        <SelectCheck checked={selected} />
        <ThreadRowContent row={row} now={now} unread={unread} />
      </button>
    </li>
  );
}

function ThreadRowContent({
  row,
  now,
  unread = false,
}: {
  row: BotThreadRow;
  now: number;
  /** Unread: the bot replied since the owner last opened it, or the owner marked it (`isChatUnread`). */
  unread?: boolean;
}) {
  const live = isThreadLive(row.shell);
  const needsYou = threadNeedsAttention(row.shell);
  return (
    <>
      {unread ? <UnreadDot /> : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[15px] text-[var(--personal-text)]",
          unread && "font-semibold",
        )}
      >
        {row.shell.title}
        {isChatPinned(row.link) ? <span className="sr-only">, pinned</span> : null}
        {unread ? <span className="sr-only">, unread</span> : null}
      </span>
      {isChatPinned(row.link) ? <PinMark /> : null}
      {needsYou ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
          <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-review)]" />
          Needs you
        </span>
      ) : isThreadRateLimited(row.shell) ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
          <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-review)]" />
          Rate limited
        </span>
      ) : live ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
          <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-live)]" />
          Working
        </span>
      ) : null}
      <time
        dateTime={new Date(row.updatedMs).toISOString()}
        className="shrink-0 text-[13px] text-[var(--personal-text-tertiary)]"
      >
        {formatRelativeTime(row.updatedMs, now)}
      </time>
    </>
  );
}

/**
 * One chat in the bot's list. Swipe left for Archive (Unarchive once
 * archived) and Delete; a tap opens the chat (an archived one read-only), or
 * closes the row while it is swiped open. Archived rows keep their buttons for
 * mouse, keyboard and VoiceOver; open chats have the same actions in the
 * chat's own "..." menu.
 * Press and hold enters select mode (also in the list's "..." menu).
 */
function ThreadRow({
  environmentId,
  botId,
  row,
  now,
  archived,
  onError,
  onLongPress,
  unread = false,
  onTogglePin,
  onSnooze,
  onWake,
}: {
  environmentId: EnvironmentId;
  botId: string;
  row: BotThreadRow;
  now: number;
  archived: boolean;
  unread?: boolean;
  onError: (message: string | null) => void;
  /** Press and hold: select mode, starting with this chat. */
  onLongPress: (threadId: string) => void;
  /** Swipe right: Pin or Unpin (open chats). */
  onTogglePin?: ((row: BotThreadRow) => void) | undefined;
  /** Swipe right: Snooze, which asks when (open chats). */
  onSnooze?: ((row: BotThreadRow) => void) | undefined;
  /** A snoozed row: its "Wake now" button, and the wake time in place of the preview. */
  onWake?: ((row: BotThreadRow) => void) | undefined;
}) {
  const threadId = row.link.threadId;
  const longPress = useLongPress(useCallback(() => onLongPress(threadId), [onLongPress, threadId]));
  const archiveThread = useAtomCommand(personalBotArchiveThread);
  const deleteChat = useDeleteChat(environmentId);
  const [busy, setBusy] = useState(false);
  const setArchived = async (next: boolean) => {
    setBusy(true);
    const result = await archiveThread({
      environmentId,
      input: { threadId: row.link.threadId, archived: next },
    });
    setBusy(false);
    onError(
      commandFailureMessage(
        result,
        next
          ? "Couldn't archive this chat. Try again."
          : "Couldn't unarchive this chat. Try again.",
      ),
    );
  };
  // The same confirm and delete path as "Delete chat" in the chat's menu.
  const onDelete = async () => {
    setBusy(true);
    const outcome = await deleteChat(row.link.threadId);
    setBusy(false);
    if (outcome.status === "failed") onError(outcome.message);
    else if (outcome.status === "done") onError(null);
  };
  const title = row.shell.title;
  const pinned = isChatPinned(row.link);
  const wakeMs =
    row.link.snoozedUntil === undefined ? null : DateTime.toEpochMillis(row.link.snoozedUntil);
  return (
    <li>
      <SwipeToDelete
        label={`Delete ${title}`}
        onDelete={onDelete}
        secondaryActions={
          archived || onWake !== undefined || onTogglePin === undefined || onSnooze === undefined
            ? undefined
            : [
                {
                  label: `${pinned ? "Unpin" : "Pin"} ${title}`,
                  text: pinned ? "Unpin" : "Pin",
                  run: () => onTogglePin(row),
                },
                { label: `Snooze ${title}`, text: "Snooze", run: () => onSnooze(row) },
              ]
        }
        trailingActions={[
          archived
            ? { label: `Unarchive ${title}`, text: "Unarchive", run: () => setArchived(false) }
            : { label: `Archive ${title}`, text: "Archive", run: () => setArchived(true) },
        ]}
      >
        {archived ? (
          <div {...longPress} className={cn("flex items-center gap-3", NO_TOUCH_SELECT)}>
            {/* Opens read-only: the history and an "Archived" bar, no composer. */}
            <Link
              to="/bots/$botId/$threadId"
              params={{ botId, threadId: row.link.threadId }}
              draggable={false}
              aria-label={`${title}, archived`}
              className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              <ThreadRowContent row={row} now={now} />
            </Link>
            {/* Out of sight on touch screens, where the swipe carries them. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => void setArchived(false)}
              className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 text-sm font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40 pointer-coarse:sr-only"
            >
              Unarchive
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void onDelete()}
              className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 text-sm font-medium text-[var(--personal-error)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40 pointer-coarse:sr-only"
            >
              Delete
            </button>
          </div>
        ) : onWake !== undefined ? (
          <div className="flex items-center gap-3">
            <Link
              to="/bots/$botId/$threadId"
              params={{ botId, threadId: row.link.threadId }}
              draggable={false}
              aria-label={`${title}, ${wakeMs === null ? "snoozed" : wakeLabel(wakeMs, now).toLowerCase()}`}
              className="flex min-h-14 min-w-0 flex-1 flex-col justify-center py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              <span className="truncate text-[15px] text-[var(--personal-text)]">{title}</span>
              {wakeMs === null ? null : (
                <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                  {wakeLabel(wakeMs, now)}
                </span>
              )}
            </Link>
            <button
              type="button"
              aria-label={`Wake ${title} now`}
              onClick={() => onWake(row)}
              className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 text-sm font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              Wake now
            </button>
          </div>
        ) : (
          <div {...longPress} className={NO_TOUCH_SELECT}>
            <Link
              to="/bots/$botId/$threadId"
              params={{ botId, threadId: row.link.threadId }}
              draggable={false}
              className="flex min-h-14 items-center gap-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              <ThreadRowContent row={row} now={now} unread={unread} />
            </Link>
          </div>
        )}
      </SwipeToDelete>
    </li>
  );
}

/** /bots/$botId: the bot's chats, newest first, with "New chat" and archived chats. */
export function BotThreadsScreen({ botId }: { botId: string }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const navigate = useNavigate();
  const backTarget = usePersonalBackTarget();
  const laptopOffline = useLaptopOffline();
  const list = usePersonalBotsList(environmentId);
  const shells = useThreadShells();
  const bot = list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  const providers = useAtomValue(primaryServerProvidersAtom);
  const modelLabel = bot === null ? null : botActiveModelShortLabel(bot, providers);
  const modelNote = bot === null ? null : fallbackNoteLabel(bot);
  const newChat = useNewChatPrompt(environmentId, bot);
  const [now] = useState(() => Date.now());
  const [wrapupError, setWrapupError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const tasks = useMemo(() => (taskFeed === null ? [] : [...taskFeed.values()]), [taskFeed]);
  useRefreshBotsForTaskThreads({
    bots: list.data?.bots ?? null,
    links: list.data?.threads ?? null,
    tasks,
    refresh: list.refresh,
    shells,
  });

  const relayThreadIds = usePersonalGroupRelayThreadIds(environmentId);
  // One timer for the nearest wake time: it moves the clock past it (a woken chat is back in the
  // list at once) and refetches, which brings it back unread at the top.
  const wakeClock = useSnoozeWakeClock(list.data?.threads, list.refresh);
  const rows = useMemo(
    () =>
      bot === null || list.data === null
        ? { active: [], archived: [], snoozed: [] }
        : botThreadRows(
            bot.botId,
            list.data.threads,
            shells.filter((shell) => shell.environmentId === environmentId),
            relayThreadIds,
            wakeClock,
          ),
    [bot, environmentId, list.data, relayThreadIds, shells, wakeClock],
  );
  // Unread dots for every bot's chats, from the same list; archived rows never get one. The chat
  // chips mark a chat unread for any bot, so the list must too (only the Bots home list keeps its
  // count badges for team leads, `showsUnreadChats`).
  const chatSeen = useChatSeenState();
  const showsUnread = bot !== null;
  const unreadThreadIds = useMemo(
    () =>
      new Set(
        showsUnread
          ? rows.active
              .filter((row) => isChatUnread(row.link, chatSeen, row.shell))
              .map((row) => row.link.threadId as string)
          : [],
      ),
    [chatSeen, rows.active, showsUnread],
  );
  // The list refetches when one of these chats finishes a turn, so a reply
  // that lands while this screen is open lights its dot (the Bots list does
  // the same through its preview key). Trailing, like the Bots list.
  const turnsKey = showsUnread
    ? rows.active
        .map((row) => `${row.link.threadId}:${row.shell.latestTurn?.completedAt ?? ""}`)
        .join("|")
    : "";
  useRefetchOnTurnsSettled(turnsKey, list.refresh);

  // Wrapup acts on the most recent open chat: the same chat "New chat" would supersede. The rows
  // are pinned first, so the newest is found by its activity, not by position.
  const newestThreadId =
    rows.active.reduce<BotThreadRow | null>(
      (newest, row) => (newest === null || row.updatedMs > newest.updatedMs ? row : newest),
      null,
    )?.link.threadId ?? null;
  const wrapupThreadRef = useMemo(
    () =>
      environmentId === null || newestThreadId === null
        ? null
        : scopeThreadRef(environmentId, newestThreadId),
    [environmentId, newestThreadId],
  );
  const wrapupThread = useThreadDetail(wrapupThreadRef);
  const { send: sendWrapup, sending: wrapupSending } = useWrapupChat(
    environmentId,
    wrapupThread,
    bot === null ? null : botEffectiveModelSelection(bot),
  );
  const wrapupDisabled =
    newestThreadId === null || laptopOffline || wrapupThread === null || wrapupSending;

  const onWrapup = async () => {
    if (newestThreadId === null || bot === null || wrapupDisabled) return;
    setWrapupError(null);
    const started = await sendWrapup();
    if (started) {
      await navigate({
        to: "/bots/$botId/$threadId",
        params: { botId: bot.botId, threadId: newestThreadId },
      });
    } else {
      setWrapupError("Couldn't start the wrapup. Try again.");
    }
  };

  // Select mode: one section at a time, so Select all never reaches the other.
  const [selection, setSelection] = useState<{
    readonly section: ChatSection;
    readonly ids: ReadonlySet<string>;
  } | null>(null);
  const [notice, setNotice] = useBulkNotice();
  const [bulkBusy, setBulkBusy] = useState(false);
  const runBulk = useBulkChatActions(environmentId);
  const selecting = selection !== null;
  const sectionRows =
    selection === null ? [] : selection.section === "archived" ? rows.archived : rows.active;
  const sectionIds = useMemo(
    () => sectionRows.map((row) => row.link.threadId as string),
    [sectionRows],
  );
  const chosen = selection === null ? [] : visibleSelection(selection.ids, sectionIds);
  const everySelected = selection !== null && allChatsSelected(selection.ids, sectionIds);

  const enterSelect = useCallback((section: ChatSection, first: string | null) => {
    setNotice(null);
    setActionError(null);
    setSelection({ section, ids: new Set(first === null ? [] : [first]) });
  }, []);
  const selectFromActive = useCallback(
    (threadId: string) => enterSelect("active", threadId),
    [enterSelect],
  );
  const selectFromArchived = useCallback(
    (threadId: string) => enterSelect("archived", threadId),
    [enterSelect],
  );
  const toggle = useCallback((threadId: string) => {
    setSelection((current) =>
      current === null ? current : { ...current, ids: toggleChatSelection(current.ids, threadId) },
    );
  }, []);
  const toggleAll = () => {
    setSelection((current) =>
      current === null ? current : { ...current, ids: new Set(everySelected ? [] : sectionIds) },
    );
  };

  const exitSelect = useCallback(() => setSelection(null), []);
  useEscapeToExit(selecting, exitSelect);

  // Snooze asks when: the sheet is for the chosen chats (select mode) or one swiped row.
  const [snoozeIds, setSnoozeIds] = useState<ReadonlyArray<string> | null>(null);
  const allChosenPinned =
    chosen.length > 0 &&
    sectionRows
      .filter((row) => chosen.includes(row.link.threadId))
      .every((row) => isChatPinned(row.link));

  // One chat, from a swipe: the same server path as the bulk bar, one id.
  const runOne = async (action: BulkChatAction, threadId: string, options?: BulkChatOptions) => {
    setActionError(null);
    const outcome = await runBulk(action, [threadId], 0, options);
    if (outcome.status === "settled" && outcome.anyFailed) setActionError(outcome.notice);
  };
  const onTogglePin = (row: BotThreadRow) =>
    void runOne(isChatPinned(row.link) ? "unpin" : "pin", row.link.threadId);
  const onSnoozeRow = (row: BotThreadRow) => setSnoozeIds([row.link.threadId]);
  const onWake = (row: BotThreadRow) => void runOne("wake", row.link.threadId);
  const onSnoozePicked = (untilMs: number) => {
    const ids = snoozeIds;
    setSnoozeIds(null);
    if (ids === null) return;
    if (selection !== null) void onBulk("snooze", { snoozeUntilMs: untilMs });
    else if (ids[0] !== undefined) void runOne("snooze", ids[0], { snoozeUntilMs: untilMs });
  };

  const onBulk = async (action: BulkChatAction, options?: BulkChatOptions) => {
    if (selection === null || chosen.length === 0 || bulkBusy) return;
    const section = selection.section;
    const working = sectionRows.filter(
      (row) => chosen.includes(row.link.threadId) && isThreadLive(row.shell),
    ).length;
    setBulkBusy(true);
    const outcome = await runBulk(action, chosen, working, options);
    setBulkBusy(false);
    if (outcome.status === "cancelled") return;
    setNotice({ text: outcome.notice, failed: outcome.anyFailed });
    // Done: back to the plain list. Refused chats stay selected for another try.
    setSelection(
      outcome.failedIds.length === 0 ? null : { section, ids: new Set(outcome.failedIds) },
    );
  };

  const noticeLine = <BulkNoticeLine notice={notice} />;

  const renderSelectable = (row: BotThreadRow) => (
    <SelectableThreadRow
      key={row.link.threadId}
      row={row}
      now={now}
      selected={selection?.ids.has(row.link.threadId) ?? false}
      onToggle={toggle}
      unread={unreadThreadIds.has(row.link.threadId)}
    />
  );

  return (
    <div className={cn("flex min-w-0 flex-col px-5", selecting ? "min-h-full" : "pb-8")}>
      {selecting ? (
        <SelectModeHeader
          label={selectedCountLabel(chosen.length)}
          everySelected={everySelected}
          canSelectAll={sectionIds.length > 0}
          onCancel={exitSelect}
          onToggleAll={toggleAll}
        />
      ) : (
        <header className="flex h-16 items-center gap-3">
          <Link
            to={backTarget.to}
            activeOptions={{ exact: true }}
            aria-label={backTarget.label}
            className={`-ml-3 ${ICON_LINK}`}
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
          {bot !== null ? (
            <>
              <BotAvatar
                shape={bot.avatarShape}
                color={bot.avatarColor}
                size={48}
                label={bot.name}
              />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
                  {bot.name}
                </h1>
                {modelLabel !== null ? (
                  <p
                    data-testid="bot-model-label"
                    className="truncate text-[13px] text-[var(--personal-text-secondary)]"
                  >
                    {modelLabel}
                    {modelNote !== null ? <span className="sr-only"> ({modelNote})</span> : null}
                  </p>
                ) : null}
              </div>
              <Link
                to="/bots/$botId/edit"
                params={{ botId: bot.botId }}
                aria-label={`Edit ${bot.name}`}
                className={ICON_LINK}
              >
                <Pencil aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </Link>
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Chat list options"
                      className={`-mr-3 ${ICON_LINK}`}
                    />
                  }
                >
                  <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
                </MenuTrigger>
                <MenuPopup align="end" className="personal-app personal-menu min-w-48">
                  <MenuItem
                    disabled={rows.active.length === 0}
                    onClick={() => enterSelect("active", null)}
                  >
                    Select chats
                  </MenuItem>
                  {rows.archived.length > 0 ? (
                    <MenuItem onClick={() => enterSelect("archived", null)}>
                      Select archived chats
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </>
          ) : (
            <h1 className="text-[19px] font-bold text-[var(--personal-text)]">Chats</h1>
          )}
        </header>
      )}

      {list.data !== null && bot === null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          This bot no longer exists.{" "}
          <Link
            to={backTarget.to}
            activeOptions={{ exact: true }}
            className="font-medium text-[var(--personal-text)] underline"
          >
            {backTarget.label}
          </Link>
        </p>
      ) : null}

      {bot !== null && environmentId !== null && selection !== null ? (
        <>
          {noticeLine}
          {selection.section === "archived" ? (
            <h2 className="mt-4 text-[15px] font-medium text-[var(--personal-text-secondary)]">
              Archived chats ({rows.archived.length})
            </h2>
          ) : null}
          {sectionRows.length === 0 ? (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No chats here.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]">
              {sectionRows.map(renderSelectable)}
            </ul>
          )}
          <SelectModeActions>
            <button
              type="button"
              onClick={() =>
                void onBulk(selection.section === "archived" ? "unarchive" : "archive")
              }
              disabled={chosen.length === 0 || bulkBusy}
              aria-busy={bulkBusy}
              className={cn("-ml-2", SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
            >
              {selection.section === "archived" ? "Unarchive" : "Archive"}
            </button>
            {selection.section === "active" ? (
              <>
                <button
                  type="button"
                  onClick={() => void onBulk(allChosenPinned ? "unpin" : "pin")}
                  disabled={chosen.length === 0 || bulkBusy}
                  className={cn(SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
                >
                  {allChosenPinned ? "Unpin" : "Pin"}
                </button>
                <button
                  type="button"
                  onClick={() => setSnoozeIds(chosen)}
                  disabled={chosen.length === 0 || bulkBusy}
                  className={cn(SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
                >
                  Snooze
                </button>
                <button
                  type="button"
                  onClick={() => void onBulk("markUnread")}
                  disabled={chosen.length === 0 || bulkBusy}
                  className={cn(SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
                >
                  Mark unread
                </button>
              </>
            ) : null}
            <SelectModeDeleteButton
              disabled={chosen.length === 0}
              busy={bulkBusy}
              onClick={() => void onBulk("delete")}
            />
          </SelectModeActions>
        </>
      ) : null}

      {newChat.dialog}
      {snoozeIds !== null ? (
        <SnoozeSheet
          title={snoozeIds.length === 1 ? "Snooze chat" : `Snooze ${snoozeIds.length} chats`}
          onPick={onSnoozePicked}
          onCancel={() => setSnoozeIds(null)}
        />
      ) : null}
      {bot !== null && environmentId !== null && selection === null ? (
        <>
          {/* Stacked on the phone; side by side on desktop, where two
              full-width 800px slabs read as banners rather than buttons. */}
          <div className="mt-3 flex flex-col gap-3 md:flex-row">
            <button
              type="button"
              onClick={() => newChat.open()}
              disabled={newChat.starting}
              aria-busy={newChat.starting}
              className="flex h-11 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] md:flex-1 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40"
            >
              <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
              New chat
            </button>
            <button
              type="button"
              onClick={() => void onWrapup()}
              disabled={wrapupDisabled}
              aria-busy={wrapupSending}
              className="flex h-11 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] md:flex-1 text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40"
            >
              <NotebookPen aria-hidden="true" className="size-5" strokeWidth={1.75} />
              Wrapup
            </button>
          </div>
          {wrapupError !== null ? (
            <p role="alert" className="mt-2 text-center text-sm text-[var(--personal-error)]">
              {wrapupError}
            </p>
          ) : null}

          {actionError !== null ? (
            <p role="alert" className="mt-2 text-center text-sm text-[var(--personal-error)]">
              {actionError}
            </p>
          ) : null}
          {noticeLine}

          {rows.active.length === 0 ? (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              {rows.snoozed.length > 0
                ? `Every chat with ${bot.name} is snoozed.`
                : `No chats with ${bot.name} yet.`}
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]">
              {rows.active.map((row) => (
                <ThreadRow
                  key={row.link.threadId}
                  environmentId={environmentId}
                  botId={bot.botId}
                  row={row}
                  now={now}
                  archived={false}
                  onError={setActionError}
                  onLongPress={selectFromActive}
                  unread={unreadThreadIds.has(row.link.threadId)}
                  onTogglePin={onTogglePin}
                  onSnooze={onSnoozeRow}
                />
              ))}
            </ul>
          )}

          {rows.snoozed.length > 0 ? (
            <details className="mt-6">
              <summary className="flex min-h-11 cursor-pointer items-center text-[15px] font-medium text-[var(--personal-text-secondary)]">
                Snoozed ({rows.snoozed.length})
              </summary>
              <ul className="divide-y divide-[var(--personal-border)]">
                {rows.snoozed.map((row) => (
                  <ThreadRow
                    key={row.link.threadId}
                    environmentId={environmentId}
                    botId={bot.botId}
                    row={row}
                    now={wakeClock}
                    archived={false}
                    onError={setActionError}
                    onLongPress={ignoreLongPress}
                    onWake={onWake}
                  />
                ))}
              </ul>
            </details>
          ) : null}

          {rows.archived.length > 0 ? (
            <details className="mt-6">
              <summary className="flex min-h-11 cursor-pointer items-center text-[15px] font-medium text-[var(--personal-text-secondary)]">
                Archived chats ({rows.archived.length})
              </summary>
              <ul className="divide-y divide-[var(--personal-border)]">
                {rows.archived.map((row) => (
                  <ThreadRow
                    key={row.link.threadId}
                    environmentId={environmentId}
                    botId={bot.botId}
                    row={row}
                    now={now}
                    archived
                    onError={setActionError}
                    onLongPress={selectFromArchived}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
