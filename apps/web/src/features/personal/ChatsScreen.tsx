import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import {
  isBotPinned,
  type PersonalBot,
  type PersonalBotId,
  type PersonalGroup,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Network, Plus, Search, Settings } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";

import { capContinuousMotion, motionForSummary } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import {
  BotRow,
  ROW_CLASS,
  SELECTED_ROW_CLASS,
  selectedChatProps,
  snapshotPreviewLabel,
} from "./BotRow";
import {
  buildBotSummaries,
  collectAttentionThreads,
  filterBotSummaries,
  partitionPinnedSummaries,
  previewRefreshKey,
  type BotSummary,
} from "./botSummaries";
import { useTogglePinBot } from "./usePinBot";
import { useComputerFeed } from "./computer/computerState";
import { useDesktopStatus, useDesktopSummaryInput } from "./computer/desktopState";
import {
  buildChatsSnapshot,
  partitionPinnedSnapshotRows,
  readChatsSnapshot,
  writeChatsSnapshot,
  type ChatsSnapshot,
  type ChatsSnapshotRow,
  type ChatsSnapshotRowInput,
} from "./chatsSnapshot";
import {
  resolveTurnChildren,
  type ServerTurn,
  serverTurnLabel,
  waitingLabelsByThread,
} from "./delegationModel";
import {
  activeGroupMembers,
  filterGroups,
  groupMemberThreadIds,
  roundForGroup,
} from "./groupModel";
import { GroupRow } from "./GroupRow";
import { PinnedBotTile, PinnedSnapshotTile, PinnedStrip } from "./PinnedStrip";
import {
  mergePersonalGroups,
  usePersonalGroupsFeed,
  usePersonalGroupsList,
} from "./usePersonalGroups";
import { reloadLatestApp, useAppVersion } from "./appVersion";
import { SwipeToDelete } from "./SwipeToDelete";
import { useDeleteBot } from "./useDeleteBot";
import { threadIdsAwaitingSecret } from "./secretRequestCards";
import { usePendingSecretRequests } from "./useSecretRequests";
import { usePersonalRoutines, usePersonalTasks } from "./usePersonalAutomation";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import { PersonalUsageStrip } from "./PersonalUsageStrip";
import { useRefreshBotsForTaskThreads } from "./useRefreshBotsForTaskThreads";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import { usePreloadChatRoute } from "./usePreloadChatRoute";
import { reportChatsListPainted } from "./perfRum";
import { formatRelativeTime } from "./relativeTime";
import { botSelectionKey, groupSelectionKey, type SidebarSelectionKey } from "./personalMode";
import { revealInSidebar } from "./sidebarReveal";

const MINUTE_MS = 60_000;
/** Coalesces preview-key moves that land together (message sent + turn start). */
const PREVIEW_REFRESH_DEBOUNCE_MS = 250;
/**
 * How long after a chat opens the list keeps its row in view while the rows
 * settle (snapshot to live list, activity order landing). Short, so it never
 * fights the owner's own scrolling.
 */
const REVEAL_SETTLE_MS = 3_000;

/** Re-render once a minute so relative timestamps and the greeting stay true. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

// `md:-mx-3` pairs with the rows' `md:px-3` (see ROW_CLASS in BotRow).
const UNPINNED_LIST_CLASS =
  "personal-row-list mt-3 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)] md:-mx-3";

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]";

/**
 * The list's load error, in the owner's words. Never the transport's own:
 * offline that was "Couldn't load your bots. Environment 0af49158-… is
 * offline." under a banner that already said so.
 */
function ListErrorText(): JSX.Element {
  const laptopOffline = useLaptopOffline();
  return (
    <p className="min-w-0 text-[15px] text-[var(--personal-text)]">
      {laptopOffline
        ? "Your laptop is offline. Your bots come back when it reconnects."
        : "Couldn't load your bots."}
    </p>
  );
}

/**
 * Cold-start placeholder: static muted rows shown only when there is no live
 * data and no snapshot (first launch). Deliberately not animated — continuous
 * repaints peg the GPU on high-refresh displays.
 */
function ChatsSkeletonRows(): JSX.Element {
  return (
    <div role="status" aria-busy="true" className="mt-3 border-y border-[var(--personal-border)]">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          aria-hidden="true"
          className="flex min-w-0 items-center gap-[18px] border-b border-[var(--personal-border)] py-4 last:border-b-0"
        >
          <div className="size-14 shrink-0 rounded-full bg-[var(--personal-fill-muted)]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="h-[17px] w-2/5 rounded-full bg-[var(--personal-fill-muted)]" />
            <div className="h-3 w-1/3 rounded-full bg-[var(--personal-fill-muted)]" />
            <div className="h-3 w-4/5 rounded-full bg-[var(--personal-fill-muted)]" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading your bots…</span>
    </div>
  );
}

/**
 * Instant cold-start paint from the persisted snapshot. Every live-state
 * indicator stays neutral — no working dots, no rate-limit or waiting labels,
 * no review row — because those need live data. The live list replaces this
 * seamlessly the moment it arrives.
 */
function SnapshotBotRows({
  snapshot,
  now,
  selectedChat,
}: {
  snapshot: ChatsSnapshot;
  now: number;
  selectedChat: SidebarSelectionKey | null;
}): JSX.Element {
  // Rows were stored in render order, so the two sections come straight off
  // the `pinned` flag and the live list lands on the same layout.
  const { pinned, rest } = partitionPinnedSnapshotRows(snapshot.rows);
  return (
    <>
      {/* The strip paints from the snapshot too. Without this a cold start
          showed no favourites and popped them in when the list landed — the
          bug the `pinned` flag was added to the snapshot to kill. */}
      {pinned.length > 0 ? (
        <PinnedStrip>
          {pinned.map((row) => (
            <PinnedSnapshotTile
              key={row.botId}
              row={row}
              selected={selectedChat === botSelectionKey(row.botId)}
            />
          ))}
        </PinnedStrip>
      ) : null}
      {rest.length > 0 ? (
        <ul aria-label="Your bots" className={UNPINNED_LIST_CLASS}>
          {rest.map((row) => (
            <SnapshotBotRow
              key={row.botId}
              row={row}
              now={now}
              selected={selectedChat === botSelectionKey(row.botId)}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

function SnapshotBotRow({
  row,
  now,
  selected,
}: {
  row: ChatsSnapshotRow;
  now: number;
  selected: boolean;
}): JSX.Element {
  const rowClass = cn(ROW_CLASS, selected && SELECTED_ROW_CLASS);
  const content = (
    <>
      <BotAvatar shape={row.avatarShape} color={row.avatarColor} size={56} label={row.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {row.name}
          </span>
          {row.previewAtMs !== null ? (
            <time
              dateTime={new Date(row.previewAtMs).toISOString()}
              className="ml-auto shrink-0 pl-3 text-[13px] leading-[22px] text-[var(--personal-text-tertiary)]"
            >
              {formatRelativeTime(row.previewAtMs, now)}
            </time>
          ) : null}
        </span>
        <span className="truncate text-sm leading-5 text-[var(--personal-text-secondary)]">
          {row.subtitle}
        </span>
        <span className="truncate text-sm leading-5 text-[var(--personal-text-preview)]">
          {row.preview}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {row.threadId !== null ? (
        <Link
          to="/bots/$botId/$threadId"
          params={{
            botId: row.botId as PersonalBotId,
            threadId: row.threadId as ThreadId,
          }}
          className={rowClass}
          {...selectedChatProps(selected)}
        >
          {content}
        </Link>
      ) : (
        <div className={rowClass} {...selectedChatProps(selected)}>
          {content}
        </div>
      )}
    </li>
  );
}

/**
 * ui-spec Screen 1: header, greeting, search, bot rows, review row.
 *
 * `selectedChat` is the chat open in the desktop pane, from the route params
 * (`sidebarSelectionKey`); only the md+ shell passes it. On the phone the list
 * is its own screen and nothing is ever selected.
 */
export function ChatsScreen({
  selectedChat = null,
}: {
  readonly selectedChat?: SidebarSelectionKey | null | undefined;
} = {}): JSX.Element {
  const navigate = useNavigate();
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const allShells = useThreadShells();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { feed: computerFeed } = useComputerFeed(environmentId);
  const desktopSummary = useDesktopSummaryInput(useDesktopStatus(environmentId));
  const routinesQuery = usePersonalRoutines(environmentId);
  const now = useMinuteClock();
  const deleteBot = useDeleteBot(environmentId);
  const [query, setQuery] = useState("");
  // Swipe-Delete has no screen of its own to report back to — the row just
  // slides shut on a refusal — so the list hosts the message.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const onDeleteBot = async (bot: Parameters<typeof deleteBot>[0]) => {
    const outcome = await deleteBot(bot);
    if (outcome.status === "cancelled") return;
    setDeleteError(outcome.status === "failed" ? outcome.message : null);
  };

  const shells = useMemo(
    () => allShells.filter((shell) => shell.environmentId === environmentId),
    [allShells, environmentId],
  );

  // Cold-start snapshot: read synchronously on first mount so the list paints
  // before auth + websocket + `personalBots.list` complete. Re-read when the
  // environment changes (a miss then clears the other environment's entry).
  const [snapshot, setSnapshot] = useState<ChatsSnapshot | null>(() =>
    readChatsSnapshot(environmentId),
  );
  const snapshotEnv = useRef(environmentId);
  useEffect(() => {
    if (snapshotEnv.current === environmentId) return;
    snapshotEnv.current = environmentId;
    setSnapshot(readChatsSnapshot(environmentId));
  }, [environmentId]);

  // The tasks feed replays every task over the same socket the first list
  // fetch needs, with O(n) map copies per 50ms batch. Arm it a frame after the
  // first paint (snapshot, skeleton or live list) so it cannot contend with
  // that paint; the timeout covers background tabs where rAF never fires.
  const loaded = list.data !== null;
  usePreloadChatRoute(loaded);
  const showingSnapshot = !loaded && snapshot !== null && snapshot.rows.length > 0;
  const firstPaintReady = loaded || showingSnapshot || list.error !== null;
  const rowsPainted = showingSnapshot || (list.data !== null && list.data.bots.length > 0);
  useEffect(() => {
    if (rowsPainted) reportChatsListPainted(!loaded);
  }, [rowsPainted, loaded]);
  const [tasksArmed, setTasksArmed] = useState(false);
  useEffect(() => {
    if (tasksArmed || !firstPaintReady) return;
    let cancelled = false;
    let outer = 0;
    let inner = 0;
    const arm = () => {
      if (!cancelled) setTasksArmed(true);
    };
    if (typeof window.requestAnimationFrame === "function") {
      outer = window.requestAnimationFrame(() => {
        inner = window.requestAnimationFrame(arm);
      });
    }
    const fallback = window.setTimeout(arm, 1_500);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
      window.clearTimeout(fallback);
    };
  }, [tasksArmed, firstPaintReady]);
  const { tasks: taskFeed } = usePersonalTasks(tasksArmed ? environmentId : null);
  // Groups ride the same gate as the tasks feed: the list query is cheap and
  // lands with the bots, the subscription replays every group and round and so
  // must not contend with the first paint.
  const groupsQuery = usePersonalGroupsList(environmentId);
  const { feed: groupsFeed } = usePersonalGroupsFeed(tasksArmed ? environmentId : null);
  const { groups, rounds } = useMemo(
    () => mergePersonalGroups(groupsQuery.data ?? null, groupsFeed ?? null),
    [groupsQuery.data, groupsFeed],
  );
  // A member thread is the bot's private relay of a group, not a chat the owner
  // started: it must not show up as one of that bot's chats (§8.8 — hidden
  // client-side in v1).
  const memberThreadIds = useMemo(() => groupMemberThreadIds(groups), [groups]);
  const tasks = useMemo(() => (taskFeed === null ? [] : [...taskFeed.values()]), [taskFeed]);
  useRefreshBotsForTaskThreads({
    bots: list.data?.bots ?? null,
    links: list.data?.threads ?? null,
    tasks,
    refresh: list.refresh,
  });
  const namesById = useMemo(
    () => new Map((list.data?.bots ?? []).map((entry) => [entry.botId as string, entry.name])),
    [list.data],
  );
  const nameOf = useCallback((botId: string) => namesById.get(botId) ?? null, [namesById]);
  const waitingByThread = useMemo(() => waitingLabelsByThread(tasks, nameOf), [tasks, nameOf]);
  const describeTurn = useCallback(
    (turn: ServerTurn) => serverTurnLabel(turn, resolveTurnChildren(turn, tasks), nameOf),
    [tasks, nameOf],
  );
  // A bot parked on `request_secret` looks idle everywhere else: its chat has
  // no pending approval and no pending user input, only a request row.
  const pendingSecretsQuery = usePendingSecretRequests(tasksArmed ? environmentId : null);
  const secretRequestThreadIds = useMemo(
    () => threadIdsAwaitingSecret(pendingSecretsQuery.data?.requests ?? []),
    [pendingSecretsQuery.data],
  );
  const summaries = useMemo(
    () =>
      list.data === null
        ? []
        : buildBotSummaries({
            bots: list.data.bots,
            links: list.data.threads.filter((link) => !memberThreadIds.has(link.threadId)),
            shells,
            providers,
            waitingByThread,
            browserHelpThreadId: computerFeed.status?.helpRequest?.threadId ?? null,
            secretRequestThreadIds,
            routines: routinesQuery.data?.routines ?? [],
            desktop: desktopSummary,
          }),
    [
      computerFeed.status?.helpRequest?.threadId,
      desktopSummary,
      list.data,
      memberThreadIds,
      providers,
      routinesQuery.data,
      secretRequestThreadIds,
      shells,
      waitingByThread,
    ],
  );
  // Previews ride on `personalBots.list`; a message boundary on a bot's newest
  // thread (see `previewRefreshKey`) refetches the list once instead of every
  // row holding a full thread subscription. Not per streamed chunk: the shell's
  // updatedAt moves on every delta and used to refetch the whole list each time.
  const previewKey = previewRefreshKey(summaries);
  const previewKeyRef = useRef<string | null>(null);
  const previewRefreshTimerRef = useRef<number | null>(null);
  const previewRefreshRef = useRef(list.refresh);
  // `newestThread` comes from the thread shells and the rows from the list, so
  // until both have landed the key is a placeholder of empty segments.
  // Adopting that placeholder as the baseline made the initial population read
  // as a message arriving and refetched the list a second time on every cold
  // start (measured: two byte-identical 12,035 B responses, 28 ms apart).
  const previewKeyReady = list.data !== null && shells.length > 0;
  useEffect(() => {
    previewRefreshRef.current = list.refresh;
    if (!previewKeyReady) return;
    if (previewKeyRef.current === null) {
      previewKeyRef.current = previewKey;
      return;
    }
    if (previewKeyRef.current === previewKey) return;
    previewKeyRef.current = previewKey;
    // Trailing, so the owner's message and the turn it starts (two key moves
    // tens of ms apart) cost one refetch, not two. The pending timer lives in a
    // ref, not in this effect's cleanup: `list` can change identity before it
    // fires, and a cleanup would drop the refetch the key change asked for.
    if (previewRefreshTimerRef.current !== null) return;
    previewRefreshTimerRef.current = window.setTimeout(() => {
      previewRefreshTimerRef.current = null;
      previewRefreshRef.current();
    }, PREVIEW_REFRESH_DEBOUNCE_MS);
  }, [list, previewKey, previewKeyReady]);
  useEffect(
    () => () => {
      if (previewRefreshTimerRef.current !== null) {
        window.clearTimeout(previewRefreshTimerRef.current);
        previewRefreshTimerRef.current = null;
      }
    },
    [],
  );
  const visible = useMemo(() => filterBotSummaries(summaries, query), [query, summaries]);
  const visibleGroups = useMemo(() => filterGroups(groups, query, nameOf), [groups, nameOf, query]);
  const botsById = useMemo(
    () => new Map((list.data?.bots ?? []).map((entry) => [entry.botId as string, entry] as const)),
    [list.data],
  );
  const memberBotsOf = useCallback(
    (group: PersonalGroup): ReadonlyArray<PersonalBot> =>
      activeGroupMembers(group).flatMap((member) => {
        const bot = botsById.get(member.botId);
        return bot === undefined ? [] : [bot];
      }),
    [botsById],
  );
  // Avatar poses for the visible rows. The cap is the point: only the first
  // working bot animates, so the list never runs more than one continuous
  // animation however many bots are busy.
  const rowMotions = useMemo(() => capContinuousMotion(visible.map(motionForSummary)), [visible]);
  // The pinned box and the list below it are one list split in two, so the
  // motion cap is still decided across every visible row, not per section.
  const motionByBotId = useMemo(
    () =>
      new Map(visible.map((summary, index) => [summary.bot.botId as string, rowMotions[index]])),
    [rowMotions, visible],
  );
  const { pinned, rest } = useMemo(() => partitionPinnedSummaries(visible), [visible]);
  // Groups stay together immediately after the pinned strip. Within that
  // block and the bot block, the existing activity order is preserved.
  const restRows = useMemo(
    () => [
      ...visibleGroups.map(
        (group) =>
          ({
            kind: "group",
            key: group.groupId,
            group,
          }) as const,
      ),
      ...rest.map((summary) => ({ kind: "bot", key: summary.bot.botId, summary }) as const),
    ],
    [rest, visibleGroups],
  );
  const togglePin = useTogglePinBot(environmentId);
  const renderRow = (summary: BotSummary) => {
    const willPin = !isBotPinned(summary.bot);
    return (
      <li key={summary.bot.botId}>
        <SwipeToDelete
          label={`Delete ${summary.bot.name}`}
          onDelete={() => onDeleteBot(summary.bot)}
          secondaryAction={{
            label: `${willPin ? "Pin" : "Unpin"} ${summary.bot.name}`,
            text: willPin ? "Pin" : "Unpin",
            run: () => togglePin(summary.bot),
          }}
        >
          <BotRow
            environmentId={environmentId!}
            summary={summary}
            now={now}
            describeTurn={describeTurn}
            motion={motionByBotId.get(summary.bot.botId)}
            selected={selectedChat === botSelectionKey(summary.bot.botId)}
          />
        </SwipeToDelete>
      </li>
    );
  };
  const attention = useMemo(() => collectAttentionThreads(summaries), [summaries]);
  const helpRequest = computerFeed.status?.helpRequest ?? null;
  const helpSummary =
    helpRequest === null
      ? null
      : (summaries.find(
          (summary) => summary.bot.botId === helpRequest.botId && summary.needsBrowserHelp,
        ) ?? null);
  const helpAlreadyCounted =
    helpRequest !== null && attention.some((thread) => thread.id === helpRequest.threadId);
  const reviewCount = attention.length + (helpSummary !== null && !helpAlreadyCounted ? 1 : 0);
  const firstAttention = attention[0] ?? null;
  const { label: versionLabel, updateAvailable } = useAppVersion();
  const [updatingApp, setUpdatingApp] = useState(false);
  const updateApp = useCallback(() => {
    if (updatingApp) return;
    setUpdatingApp(true);
    void reloadLatestApp();
  }, [updatingApp]);
  const firstAttentionBot =
    firstAttention === null
      ? null
      : (summaries.find((summary) => summary.attentionThreads.includes(firstAttention))?.bot ??
        null);
  const firstReviewTarget =
    helpRequest !== null && helpSummary !== null
      ? { botId: helpSummary.bot.botId, threadId: helpRequest.threadId }
      : firstAttention !== null && firstAttentionBot !== null
        ? { botId: firstAttentionBot.botId, threadId: firstAttention.id }
        : null;

  // Persist the render snapshot after each successful list fetch. The effect
  // only writes when the row content actually changed, so task-feed updates
  // that leave the rows alone cost nothing.
  const snapshotRows = useMemo<ChatsSnapshotRowInput[] | null>(() => {
    if (environmentId === null || list.data === null) return null;
    // Stored in render order — the pinned box first, then the list under it —
    // so a cold paint can rebuild both sections without knowing team or lead
    // rank, and the rows do not reshuffle when the live list replaces them.
    const split = partitionPinnedSummaries(summaries);
    return [...split.pinned, ...split.rest].map((summary) => ({
      botId: summary.bot.botId,
      name: summary.bot.name,
      avatarShape: summary.bot.avatarShape,
      avatarColor: summary.bot.avatarColor,
      subtitle: summary.bot.title,
      previewLabel: snapshotPreviewLabel(summary, describeTurn),
      previewAtMs: summary.lastActivityMs,
      threadId: summary.newestThread === null ? null : (summary.newestThread.id as string),
      threadTitle: summary.newestThread === null ? null : summary.newestThread.title,
      pinned: isBotPinned(summary.bot),
    }));
  }, [environmentId, list.data, summaries, describeTurn]);
  const snapshotKey = snapshotRows === null ? null : JSON.stringify(snapshotRows);
  const lastPersistedKey = useRef<string | null>(null);
  useEffect(() => {
    if (environmentId === null || snapshotRows === null || snapshotKey === null) return;
    if (lastPersistedKey.current === snapshotKey) return;
    lastPersistedKey.current = snapshotKey;
    writeChatsSnapshot(
      environmentId,
      buildChatsSnapshot({ environmentId, savedAtMs: Date.now(), rows: snapshotRows }),
    );
  }, [environmentId, snapshotRows, snapshotKey]);

  // Keep the open chat's row on screen when the chat changes from outside the
  // list (a notification, a delegation card, the Team chart, a deep link).
  // Per selection, not per render: a row re-sorting under a streaming reply
  // must not drag the list along. The one exception is the settle window just
  // after a chat opens, when the live list replaces the snapshot and the
  // activity order lands with the thread shells, which can carry the row off
  // screen again. A row the owner just clicked is already in view, and a fully
  // visible row is never nudged.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clickedRef = useRef<Element | null>(null);
  const revealedRef = useRef<{
    readonly key: SidebarSelectionKey;
    readonly at: number;
    readonly fromList: boolean;
  } | null>(null);
  useEffect(() => {
    if (selectedChat === null) {
      revealedRef.current = null;
      return;
    }
    // The live rows are deps on purpose: a re-sort re-runs this within the
    // settle window below. Before they land (skeleton or cold-start snapshot)
    // there is nothing to reveal yet.
    if (pinned.length === 0 && restRows.length === 0) return;
    const root = rootRef.current;
    const row = root?.querySelector<HTMLElement>("[data-sidebar-selected]") ?? null;
    // Not painted yet (list still loading) or filtered out by the search:
    // this runs again when the rows change.
    if (root == null || row === null) return;
    const boundary = root.closest("aside");
    const prior = revealedRef.current;
    if (prior !== null && prior.key === selectedChat) {
      if (!prior.fromList && performance.now() - prior.at < REVEAL_SETTLE_MS) {
        revealInSidebar(row, boundary);
      }
      return;
    }
    const clicked = clickedRef.current;
    clickedRef.current = null;
    const fromList =
      clicked !== null && (clicked === row || clicked.contains(row) || row.contains(clicked));
    revealedRef.current = { key: selectedChat, at: performance.now(), fromList };
    if (!fromList) revealInSidebar(row, boundary);
  }, [selectedChat, pinned, restRows]);

  return (
    <div
      ref={rootRef}
      onClickCapture={(event) => {
        clickedRef.current = (event.target as Element).closest("a, button");
      }}
      // md+: 6px less on the right, where the list's scrollbar lane sits
      // (`personal-scroll-quiet` reserves it), so both edges read as 20px.
      className="flex min-h-full min-w-0 flex-col px-5 pb-6 md:pr-3.5"
    >
      <header className="flex h-14 items-center justify-between">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">Bots</h1>
          {versionLabel !== null ? (
            <span className="text-[12px] leading-none font-medium text-[var(--personal-text-secondary)] tabular-nums">
              {versionLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <Link to="/bots/team" aria-label="Team" className={ICON_BUTTON}>
            <Network
              aria-hidden="true"
              className="size-[22px] text-[var(--personal-text)]"
              strokeWidth={1.75}
            />
          </Link>
          <Link to="/bots/settings" aria-label="Settings" className={ICON_BUTTON}>
            <Settings
              aria-hidden="true"
              className="size-[22px] text-[var(--personal-text)]"
              strokeWidth={1.75}
            />
          </Link>
          {/* One "+" for both kinds of chat: a group is a chat, not a second
              object with a surface of its own [Grok: subtraction]. */}
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="New"
                  className={`${ICON_BUTTON} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
                />
              }
            >
              <Plus aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
            </MenuTrigger>
            <MenuPopup align="end" className="personal-app personal-menu min-w-44">
              <MenuItem onClick={() => void navigate({ to: "/bots/new" })}>New bot</MenuItem>
              <MenuItem onClick={() => void navigate({ to: "/bots/groups/new" })}>
                New group
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </header>

      <PersonalUsageStrip now={now} />

      {environmentId === null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          Not connected to your computer yet.{" "}
          <Link
            to="/settings/connections"
            className="font-medium text-[var(--personal-text)] underline"
          >
            Open Connections
          </Link>
        </p>
      ) : null}

      {list.error !== null ? (
        <div className="mt-6 flex items-center justify-between gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
          <ListErrorText />
          <button
            type="button"
            onClick={list.refresh}
            className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-medium text-[var(--personal-text)]"
          >
            Try again
          </button>
        </div>
      ) : null}

      {deleteError !== null ? (
        <p
          role="alert"
          className="mt-4 rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] px-3.5 py-2.5 text-sm break-words text-[var(--personal-danger)]"
        >
          {deleteError}
        </p>
      ) : null}

      {loaded && summaries.length === 0 && groups.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <p className="text-lg font-semibold text-[var(--personal-text)]">No bots yet</p>
          <p className="max-w-[280px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
            Give a bot a name, a look and a provider, then chat with it from anywhere.
          </p>
          <Link
            to="/bots/new"
            className="mt-2 flex h-11 items-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)]"
          >
            Create your first bot
          </Link>
        </div>
      ) : null}

      {loaded && (summaries.length > 0 || groups.length > 0) ? (
        <>
          <div className="relative mt-2.5">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-[var(--personal-text-secondary)]"
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search bots and chats"
              aria-label="Search bots and chats"
              className="h-11 w-full rounded-full border-0 bg-[var(--personal-fill-muted)] pr-4 pl-10 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            />
          </div>

          {visible.length > 0 || visibleGroups.length > 0 ? (
            <>
              {pinned.length > 0 ? (
                <PinnedStrip>
                  {pinned.map((summary) => (
                    <PinnedBotTile
                      key={summary.bot.botId}
                      environmentId={environmentId!}
                      summary={summary}
                      now={now}
                      motion={motionByBotId.get(summary.bot.botId)}
                      onUnpin={() => void togglePin(summary.bot)}
                      selected={selectedChat === botSelectionKey(summary.bot.botId)}
                    />
                  ))}
                </PinnedStrip>
              ) : null}
              {restRows.length > 0 ? (
                <ul aria-label="Your chats" className={UNPINNED_LIST_CLASS}>
                  {restRows.map((row) =>
                    row.kind === "bot" ? (
                      renderRow(row.summary)
                    ) : (
                      <li key={row.key}>
                        <GroupRow
                          group={row.group}
                          round={roundForGroup(rounds, row.group.groupId)}
                          bots={memberBotsOf(row.group)}
                          now={now}
                          selected={selectedChat === groupSelectionKey(row.group.groupId)}
                        />
                      </li>
                    ),
                  )}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No bots or chats match "{query.trim()}".
            </p>
          )}

          {firstReviewTarget !== null ? (
            <Link
              to="/bots/$botId/$threadId"
              params={firstReviewTarget}
              className="mt-3 flex h-[50px] items-center gap-3 rounded-xl border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] px-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full bg-[var(--personal-review)]"
              />
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--personal-text)]">
                {reviewCount === 1
                  ? "1 item needs your review"
                  : `${reviewCount} items need your review`}
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                strokeWidth={1.75}
              />
            </Link>
          ) : null}
        </>
      ) : null}

      {loaded ? null : showingSnapshot && snapshot !== null ? (
        <SnapshotBotRows snapshot={snapshot} now={now} selectedChat={selectedChat} />
      ) : list.error === null ? (
        <ChatsSkeletonRows />
      ) : null}

      {versionLabel !== null && updateAvailable ? (
        <div className="mt-auto pt-8">
          <button
            type="button"
            onClick={updateApp}
            disabled={updatingApp}
            className="mx-auto flex min-h-11 items-center justify-center rounded-full px-4 text-[13px] font-semibold text-[var(--personal-primary)]"
          >
            {updatingApp ? "Updating…" : `Update to ${versionLabel} - tap to refresh`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
