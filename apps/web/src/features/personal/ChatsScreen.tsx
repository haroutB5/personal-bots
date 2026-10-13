import type { JSX } from "react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAtomValue } from "@effect/atom-react";
import {
  hidesBotPreviews,
  isBotPinned,
  type EnvironmentId,
  type PersonalBot,
  type PersonalBotId,
  type PersonalGroup,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Network, Plus, Search, Settings, X } from "lucide-react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";

import {
  cometRowIndexes,
  firstContinuousMotionOnly,
  motionForSummary,
  type AvatarMotion,
} from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { selectedChatProps } from "./BotRow";
import { buildBotSummaries } from "./botSummaries";
import { BotPickerSheet } from "./BotPickerSheet";
import { buildChatSections, plainGroups, sectionRowMatches } from "./chatSections";
import type { ChatSectionRow } from "./chatSections";
import { SnoozedChatList, type ChatSectionActions } from "./ChatSectionRows";
import { isChatPinned, isChatSnoozed, pinnedFirst } from "./chatState";
import { isTurnThinking } from "./conversationModel";
import { isThreadErrored } from "./botSummaries";
import {
  buildChatsSnapshot,
  readChatsSnapshot,
  readChatsSnapshotBeforeEnvironment,
  writeChatsSnapshot,
  type ChatsSnapshot,
  type ChatsSnapshotRow,
  type ChatsSnapshotRowInput,
} from "./chatsSnapshot";
import {
  resolveTurnChildren,
  serverTurnLabel,
  threadIdsWithEndedTasks,
  waitingLabelsByThread,
  type ServerTurn,
} from "./delegationModel";
import {
  activeGroupMembers,
  filterGroups,
  groupRelayThreadIds,
  isGroupRelayLink,
  roundForGroup,
  shownInChats,
} from "./groupModel";
import { HomeChatRowView, HomeGroupRowView } from "./HomeChatRow";
import { HomeFilters } from "./HomeFilters";
import { HomeRail, type RailBotItem, type RailChatItem, type RailGroupItem } from "./HomeRail";
import {
  buildHomeRows,
  cardCaption,
  chatRowPreview,
  filterHomeRows,
  homeChatBases,
  isChatRowLive,
  railBots,
  railCaption,
  railCards,
  visibleHomeRows,
  type HomeChatBase,
  type HomeChatRow,
  type HomeFilter,
  type HomeRow,
  type RowPreviewTone,
} from "./homeRows";
import { HOME_ROW_PITCH, homeWindowSpacers } from "./homeWindow";
import { MessageSearchResults } from "./MessageSearchResults";
import { deriveNeedsYou, type NeedsYouModel } from "./needsYou";
import { publishNeedsYouCount } from "./needsYouStore";
import { useChatSeenState } from "./unreadChats";
import { useBulkChatActions } from "./useBulkChatActions";
import { useGroupChatState } from "./useGroupChatState";
import { findScrollParent, useHomeWindow } from "./useHomeWindow";
import { useSnoozeWakeClock } from "./useSnoozeWakeClock";
import { useStagedCount } from "./useStagedCount";
import { useComputerFeed } from "./computer/computerState";
import { useDesktopStatus, useDesktopSummaryInput } from "./computer/desktopState";
import { threadIdsAwaitingApproval } from "./connectionApprovalCards";
import { usePendingConnectionApprovals } from "./useConnectionApprovals";
import {
  mergePersonalGroups,
  usePersonalGroupsFeed,
  usePersonalGroupsList,
} from "./usePersonalGroups";
import { reloadLatestApp, useAppVersion } from "./appVersion";
import { UpdateStatusLine } from "./UpdateStatusLine";
import { usePendingSecretRequests } from "./useSecretRequests";
import { useNeedsYouLoginRequests } from "./useNeedsYouLoginRequests";
import { usePersonalRoutines, usePersonalTasks } from "./usePersonalAutomation";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import { PersonalUsageStrip } from "./PersonalUsageStrip";
import { useRefreshBotsForTaskThreads } from "./useRefreshBotsForTaskThreads";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import {
  currentProgressNote,
  currentTurnHasToolStep,
  useWorkingProgressNotes,
} from "./useWorkingProgress";
import { usePreloadChatRoute } from "./usePreloadChatRoute";
import { reportChatsListPainted } from "./perfRum";
import { perfOptimizationOn } from "./perfFlags";
import { botSelectionKey, groupSelectionKey, type SidebarSelectionKey } from "./personalMode";
import { formatRelativeTime } from "./relativeTime";
import { revealDelta, revealInSidebar } from "./sidebarReveal";

const MINUTE_MS = 60_000;
/** Rows the first live commit draws on a first launch, and rows added per frame after it. */
const HOME_FIRST_ROWS = 6;
const HOME_STEP_ROWS = 3;
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
    // A list kept hidden under a chat (keptBotsList.ts) had no clock running:
    // catch up as it shows again. No re-render when under a minute has passed.
    setNow((prev) => (Date.now() - prev >= MINUTE_MS ? Date.now() : prev));
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** 44 px round header icons; the "+" is the one filled control up here. */
const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const ICON_BUTTON_FILLED = cn(
  ICON_BUTTON,
  "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]",
);

/**
 * Whether the preview key moved at a message boundary worth one list refetch:
 * a chat already in the key changed its own fields. A chat appearing or
 * leaving comes from the list itself (a new chat, an archive), so those never
 * count — that was the second and third list request per app open.
 */
function previewKeyAdvancedForChats(previous: string, next: string): boolean {
  if (previous === next) return false;
  const parse = (key: string) => {
    const out = new Map<string, string>();
    for (const segment of key.split("|")) {
      const separator = segment.indexOf("=");
      if (separator <= 0) continue;
      out.set(segment.slice(0, separator), segment.slice(separator + 1));
    }
    return out;
  };
  const before = parse(previous);
  for (const [threadId, fields] of parse(next)) {
    const old = before.get(threadId);
    if (old === undefined) continue;
    if (old !== fields) return true;
  }
  return false;
}

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
          className="flex min-w-0 items-center gap-3 border-b border-[var(--personal-border)] px-4 last:border-b-0"
          style={{ height: 72 }}
        >
          <div className="size-12 shrink-0 rounded-full bg-[var(--personal-fill-muted)]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="h-[17px] w-2/5 rounded-full bg-[var(--personal-fill-muted)]" />
            <div className="h-3 w-3/5 rounded-full bg-[var(--personal-fill-muted)]" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading your bots…</span>
    </div>
  );
}

/**
 * The instant cold-start paint, from the persisted snapshot: the same chat
 * rows the live list draws, with every live indicator neutral (the snapshot
 * holds no live state, and this is replaced in place the moment
 * `personalBots.list` lands).
 */
function SnapshotRows({
  snapshot,
  now,
  selectedChat,
}: {
  snapshot: ChatsSnapshot;
  now: number;
  selectedChat: SidebarSelectionKey | null;
}): JSX.Element {
  const { listRef, range } = useHomeWindow(snapshot.rows.length);
  if (snapshot.rows.length === 0) return <ChatsSkeletonRows />;
  const spacers = homeWindowSpacers(range, snapshot.rows.length);
  const all = snapshot.rows;
  const drawn =
    range.start === 0 && range.end === all.length ? all : all.slice(range.start, range.end);
  return (
    <ul
      ref={listRef}
      aria-label="Your chats"
      data-testid="snapshot-rows"
      className="home-rows mt-1"
    >
      {spacers.above > 0 ? (
        <li aria-hidden="true" data-home-window-pad="" style={{ height: spacers.above }} />
      ) : null}
      {drawn.map((row, index) => (
        <SnapshotRow
          key={`${row.botId}:${row.threadId ?? row.name}`}
          row={row}
          now={now}
          selected={selectedChat === botSelectionKey(row.botId)}
          posInSet={range.start + index + 1}
          setSize={all.length}
        />
      ))}
      {spacers.below > 0 ? (
        <li aria-hidden="true" data-home-window-pad="" style={{ height: spacers.below }} />
      ) : null}
    </ul>
  );
}

function SnapshotRow({
  row,
  now,
  selected,
  posInSet,
  setSize,
}: {
  row: ChatsSnapshotRow;
  now: number;
  selected: boolean;
  posInSet: number;
  setSize: number;
}): JSX.Element {
  const rowClass = cn(
    "home-row relative flex h-[72px] w-full min-w-0 items-center gap-3 px-4 text-left",
    selected && "md:bg-[var(--personal-fill-muted)] md:[--personal-bg:var(--personal-fill-muted)]",
  );
  const content = (
    <>
      <BotAvatar shape={row.avatarShape} color={row.avatarColor} size={48} label={row.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex h-[22px] min-w-0 items-baseline gap-2">
          <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {row.threadTitle ?? row.name}
          </span>
          {row.previewAtMs !== null ? (
            <time
              dateTime={new Date(row.previewAtMs).toISOString()}
              className="ml-auto shrink-0 text-[13px] leading-[22px] text-[var(--personal-text-tertiary)] tabular-nums"
            >
              {formatRelativeTime(row.previewAtMs, now)}
            </time>
          ) : null}
        </span>
        <span className="flex h-6 min-w-0 items-center gap-2 text-[15px] leading-5">
          <span className="min-w-0 flex-1 truncate text-[var(--personal-text-preview)]">
            <span className="text-[var(--personal-text-secondary)]">{row.name}:</span> {row.preview}
          </span>
        </span>
      </span>
    </>
  );
  return (
    <li aria-posinset={posInSet} aria-setsize={setSize}>
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
 * The Bots home: the rail (pinned chats, then bots), the filters, and one
 * 72 px row per chat across every bot, with groups among them. The needs-you
 * count on the chip and on the tab badge comes from one derivation
 * (`needsYou.ts`) over a fixed set of sources, so the two can never disagree.
 *
 * `selectedChat` is the chat open in the desktop pane, from the route params
 * (`sidebarSelectionKey`); only the md+ shell passes it.
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HomeFilter>("all");
  // The chat (or group) open in the desktop pane, straight off the route
  // params: one row per chat now, so the mark is the exact chat, not its bot.
  const openThreadId = useParams({
    strict: false,
    select: (params: { threadId?: string }) => params.threadId ?? null,
  });
  const openGroupId = useParams({
    strict: false,
    select: (params: { groupId?: string }) => params.groupId ?? null,
  });
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [sectionBusy, setSectionBusy] = useState(false);
  /**
   * Whether the list is the thing on screen. On the phone the shell keeps it
   * mounted under an open chat (`keep-list`), hidden with `display: none`:
   * while that is the case the home stops the work only the rows need - the
   * cold-start snapshot write, the per-chat progress reads and the
   * list-refetch timer - so an open chat owns the main thread. Everything
   * resumes on the first paint after Back, and the queries that feed the
   * badge stay mounted so the count never flickers.
   */
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const node = rootRef.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      setOnScreen(entry?.isIntersecting ?? true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const shells = useMemo(
    () => allShells.filter((shell) => shell.environmentId === environmentId),
    [allShells, environmentId],
  );

  // Cold-start snapshot: read synchronously on first mount so the list paints
  // before auth + websocket + `personalBots.list` complete. Re-read when the
  // environment changes (a miss then clears the other environment's entry).
  const [snapshot, setSnapshot] = useState<ChatsSnapshot | null>(() =>
    environmentId === null && perfOptimizationOn("snapshot-early")
      ? readChatsSnapshotBeforeEnvironment()
      : readChatsSnapshot(environmentId),
  );
  const snapshotEnv = useRef(environmentId);
  useEffect(() => {
    if (snapshotEnv.current === environmentId) return;
    snapshotEnv.current = environmentId;
    setSnapshot(readChatsSnapshot(environmentId));
  }, [environmentId]);

  const loaded = list.data !== null;
  const showingSnapshot = !loaded && snapshot !== null && snapshot.rows.length > 0;
  // Whether the saved rows were on screen before the live list arrived. When
  // they were, the live list must replace them whole (fewer rows for a frame
  // would read as a flicker); with nothing saved to show (a first launch) the
  // live list mounts in steps instead (useStagedCount).
  const snapshotShownRef = useRef(false);
  if (showingSnapshot) snapshotShownRef.current = true;
  // The live list has been on screen once: a later mount of its parts (a
  // filter that was empty and is not any more) draws at once.
  const liveShownRef = useRef(false);
  const [stageMountOn] = useState(() => perfOptimizationOn("home-stage-mount"));
  const stageMount = stageMountOn && !snapshotShownRef.current && !liveShownRef.current;
  const firstPaintReady = loaded || showingSnapshot || list.error !== null;
  usePreloadChatRoute(firstPaintReady);
  const rowsPainted = showingSnapshot || (list.data !== null && list.data.threads.length > 0);
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
  const groupsQuery = usePersonalGroupsList(environmentId);
  const { feed: groupsFeed } = usePersonalGroupsFeed(tasksArmed ? environmentId : null);
  const { groups, archivedGroups, rounds } = useMemo(
    () => mergePersonalGroups(groupsQuery.data ?? null, groupsFeed ?? null),
    [groupsQuery.data, groupsFeed],
  );
  const snoozeItems = useMemo(
    () => [...(list.data?.threads ?? []), ...groups],
    [groups, list.data?.threads],
  );
  const wakeClock = useSnoozeWakeClock(snoozeItems, list.refresh);
  const memberThreadIds = useMemo(
    () => groupRelayThreadIds({ groups, archivedGroups }),
    [archivedGroups, groups],
  );
  const tasks = useMemo(() => (taskFeed === null ? [] : [...taskFeed.values()]), [taskFeed]);
  useRefreshBotsForTaskThreads({
    bots: list.data?.bots ?? null,
    links: list.data?.threads ?? null,
    tasks,
    refresh: list.refresh,
    shells,
  });
  const namesById = useMemo(
    () => new Map((list.data?.bots ?? []).map((entry) => [entry.botId as string, entry.name])),
    [list.data],
  );
  const nameOf = useCallback((botId: string) => namesById.get(botId) ?? null, [namesById]);
  const waitingByThread = useMemo(() => waitingLabelsByThread(tasks, nameOf), [tasks, nameOf]);
  const endedTaskThreadIds = useMemo(() => threadIdsWithEndedTasks(tasks), [tasks]);
  const describeTurn = useCallback(
    (turn: ServerTurn) => serverTurnLabel(turn, resolveTurnChildren(turn, tasks), nameOf),
    [tasks, nameOf],
  );
  const chatSeen = useChatSeenState();

  // --- Open requests: one derivation for the chip, the badge and the rows ------------
  const pendingSecretsQuery = usePendingSecretRequests(tasksArmed ? environmentId : null);
  const pendingApprovalsQuery = usePendingConnectionApprovals(tasksArmed ? environmentId : null);
  const approvalThreadIds = useMemo(
    () => threadIdsAwaitingApproval(pendingApprovalsQuery.data?.approvals ?? []),
    [pendingApprovalsQuery.data],
  );
  const browserHelpThreadId = computerFeed.status?.helpRequest?.threadId ?? null;
  // The whole machine's open sign-ins, one RPC (1.67.0): plain chats included,
  // no per-chat asks and no dependence on the tasks feed.
  const openLoginRequests = useNeedsYouLoginRequests(tasksArmed ? environmentId : null);
  const chatBases = useMemo(
    () =>
      homeChatBases({
        bots: list.data?.bots ?? [],
        links: list.data?.threads ?? [],
        shells,
        relayThreadIds: memberThreadIds,
        nowMs: wakeClock,
        seen: chatSeen,
      }),
    [chatSeen, list.data, memberThreadIds, shells, wakeClock],
  );
  const openGroupIds = useMemo(
    () => new Set(plainGroups(groups, wakeClock).map((group) => group.groupId)),
    [groups, wakeClock],
  );
  const needsYou: NeedsYouModel = useMemo(
    () =>
      deriveNeedsYou({
        threads: chatBases.map((base) => ({
          threadId: base.key,
          botId: base.bot.botId,
          shell: base.shell,
        })),
        secretRequests: pendingSecretsQuery.data?.requests ?? [],
        // The machine's open sign-ins, from one global list (see
        // useNeedsYouLoginRequests).
        loginRequests: openLoginRequests,
        browserHelpThreadId,
        approvalThreadIds,
        groupIds: openGroupIds,
        rounds,
      }),
    [
      approvalThreadIds,
      browserHelpThreadId,
      chatBases,
      openGroupIds,
      openLoginRequests,
      pendingSecretsQuery.data,
      rounds,
    ],
  );
  useEffect(() => {
    publishNeedsYouCount(needsYou.count);
  }, [needsYou]);
  const rows = useMemo(
    () => buildHomeRows({ chatBases, groups, rounds, needsYou, nowMs: wakeClock }),
    [chatBases, groups, needsYou, rounds, wakeClock],
  );

  // Every live chat asks for its own progress note (the working line a row
  // shows). One thread per live chat, never a subscription per row.
  const progressTargets = useMemo(
    () =>
      onScreen
        ? chatBases.flatMap((base) =>
            isChatRowLive(base) && !hidesBotPreviews(base.bot)
              ? [{ threadId: base.key, updatedAt: base.shell.updatedAt }]
              : [],
          )
        : [],
    [chatBases, onScreen],
  );
  const progressNotes = useWorkingProgressNotes(environmentId, progressTargets);

  /** The preview and tone of each chat row: the one place they are computed. */
  const previewByKey = useMemo(() => {
    const previews = new Map<string, { text: string; tone: RowPreviewTone }>();
    for (const row of rows) {
      if (row.kind !== "chat") continue;
      const entry = progressNotes.get(row.key);
      const live = isChatRowLive(row);
      const note = currentProgressNote(entry, row.shell);
      const thinking =
        live && isTurnThinking(row.shell) && !currentTurnHasToolStep(entry, row.shell);
      // A chat whose last reply failed says so - unless it is also waiting on
      // the owner, where the request is the thing to act on.
      if (!live && row.request === null && isThreadErrored(row.shell)) {
        previews.set(row.key, { text: "Couldn't reply", tone: "plain" });
        continue;
      }
      previews.set(row.key, chatRowPreview({ row, progressNote: note, thinking }));
    }
    return previews;
  }, [progressNotes, rows]);

  // Chip taps retain their deferred list update. Search can narrow the rows
  // in the input commit, avoiding an extra render of the old results first.
  // Every list description (rows, empty note, Needs you footnote) reads the
  // same pair on both paths.
  const [deferListInput] = useState(() => perfOptimizationOn("home-filter-defer"));
  const [syncSearch] = useState(() => perfOptimizationOn("home-search-sync"));
  const deferredFilter = useDeferredValue(filter);
  const deferredQuery = useDeferredValue(syncSearch ? "" : query);
  const listFilter = deferListInput ? deferredFilter : filter;
  const listQuery = deferListInput && !syncSearch ? deferredQuery : query;
  const shownRows = useMemo(
    () => visibleHomeRows({ rows, filter: listFilter, query: listQuery, nameOf }),
    [listFilter, nameOf, listQuery, rows],
  );
  // What the list last drew while it was on screen. Under an open chat the
  // shell hides it, and these stay as they were: the rows do not re-render
  // until Back (see HomeRowsList). Nothing else reads them.
  const lastShownRef = useRef<{
    readonly rows: ReadonlyArray<HomeRow>;
    readonly now: number;
  } | null>(null);
  if (onScreen || lastShownRef.current === null) {
    lastShownRef.current = { rows: shownRows, now };
  }
  const drawnRows = onScreen ? shownRows : lastShownRef.current.rows;
  const rowsDrawn = drawnRows.length > 0;
  useEffect(() => {
    if (rowsDrawn) liveShownRef.current = true;
  }, [rowsDrawn]);

  // Avatar poses for the rows on screen. A row with nothing to say gets no
  // pose at all: the plain SVG avatar, no pose machinery, no observer. The
  // home draws one row per chat (the old home drew one per bot), so a quiet
  // row has to cost as little as a plain list row does. Live rows carry
  // working or thinking, a row waiting on the owner carries the waiting pose,
  // a failed reply blocked. Transform and opacity only, paused while off
  // screen (BotAvatar, avatarOffscreen.ts) and dropped under reduced motion;
  // the kill switches are the ones the bot rows used.
  const motionByKey = useMemo(() => {
    const wanted: Array<AvatarMotion | undefined> = shownRows.map((row) => {
      if (row.kind !== "chat") return undefined;
      if (isChatRowLive(row)) {
        return previewByKey.get(row.key)?.tone === "thinking" ? "thinking" : "working";
      }
      if (row.request !== null) return "waiting";
      if (isThreadErrored(row.shell)) return "blocked";
      return undefined;
    });
    const motions: AvatarMotion[] = wanted.map((motion) => motion ?? "idle");
    const shown = perfOptimizationOn("all-busy-motion")
      ? motions
      : firstContinuousMotionOnly(motions);
    return new Map(
      shownRows.map(
        (row, index) => [row.key, wanted[index] === undefined ? undefined : shown[index]] as const,
      ),
    );
  }, [previewByKey, shownRows]);
  const cometKeys = useMemo(() => {
    if (!perfOptimizationOn("anim-comet")) return new Set<string>();
    const indexes = cometRowIndexes(
      shownRows.map((row) => motionByKey.get(row.key)),
      !perfOptimizationOn("anim-all"),
    );
    return new Set(indexes.map((index) => shownRows[index]!.key));
  }, [motionByKey, shownRows]);

  // --- The rail ----------------------------------------------------------------------
  const summaries = useMemo(
    () =>
      list.data === null
        ? []
        : buildBotSummaries({
            bots: list.data.bots,
            links: list.data.threads.filter((link) => !isGroupRelayLink(link, memberThreadIds)),
            shells,
            providers,
            waitingByThread,
            endedTaskThreadIds,
            browserHelpThreadId,
            secretRequestThreadIds: threadIdsWithKind(needsYou, "secret"),
            routines: routinesQuery.data?.routines ?? [],
            desktop: desktopSummary,
            nowMs: wakeClock,
          }),
    [
      browserHelpThreadId,
      desktopSummary,
      endedTaskThreadIds,
      list.data,
      memberThreadIds,
      needsYou,
      providers,
      routinesQuery.data,
      shells,
      waitingByThread,
      wakeClock,
    ],
  );
  const modelLabels = useMemo(
    () =>
      new Map(summaries.map((summary) => [summary.bot.botId as string, summary.modelShortLabel])),
    [summaries],
  );
  const botsNeeding = useMemo(() => {
    const out = new Set<string>();
    for (const base of chatBases) {
      if (needsYou.byRow.has(base.key)) out.add(base.bot.botId);
    }
    return out;
  }, [chatBases, needsYou]);
  const cardMotions = useMemo(() => {
    const cards = railCards(rows);
    const wanted: Array<AvatarMotion | undefined> = cards.map((row) => {
      if (row.kind !== "chat") return undefined;
      if (isChatRowLive(row)) {
        return previewByKey.get(row.key)?.tone === "thinking" ? "thinking" : "working";
      }
      if (row.request !== null) return "waiting";
      return undefined;
    });
    const motions: AvatarMotion[] = wanted.map((motion) => motion ?? "idle");
    const drawn = perfOptimizationOn("all-busy-motion")
      ? motions
      : firstContinuousMotionOnly(motions);
    const comets = new Set(
      cometRowIndexes(drawn, !perfOptimizationOn("anim-all")).map((index) => cards[index]!.key),
    );
    return new Map(
      cards.map(
        (row, index) =>
          [
            row.key,
            {
              motion: wanted[index] === undefined ? undefined : drawn[index],
              comet: comets.has(row.key),
            },
          ] as const,
      ),
    );
  }, [previewByKey, rows]);
  const railChatItems = useMemo<ReadonlyArray<RailChatItem>>(
    () =>
      railCards(rows)
        .filter((row): row is HomeChatRow => row.kind === "chat")
        .map((row) => ({
          threadId: row.key,
          selected: openThreadId === row.key,
          botId: row.bot.botId,
          botName: row.bot.name,
          title: row.title,
          avatarShape: row.bot.avatarShape,
          avatarColor: row.bot.avatarColor,
          caption: cardCaption({
            row,
            tone: previewByKey.get(row.key)?.tone ?? "plain",
            live: isChatRowLive(row),
            round: null,
            modelLabel: modelLabels.get(row.bot.botId) ?? null,
          }),
          motion: cardMotions.get(row.key)?.motion,
          comet: cardMotions.get(row.key)?.comet ?? false,
          ring: row.request !== null,
          unread: row.unread,
        })),
    [cardMotions, modelLabels, openThreadId, previewByKey, rows],
  );
  const railGroupItems = useMemo<ReadonlyArray<RailGroupItem>>(
    () =>
      railCards(rows)
        .filter((row) => row.kind === "group")
        .map((row) => ({
          groupId: row.key,
          selected: openGroupId === row.key,
          name: row.group.name,
          members: activeGroupMembers(row.group).flatMap((member) => {
            const bot = (list.data?.bots ?? []).find(
              (candidate) => candidate.botId === member.botId,
            );
            return bot === undefined ? [] : [bot];
          }),
          caption: cardCaption({
            row,
            tone: "plain",
            live: false,
            round: row.round,
            modelLabel: null,
          }),
        })),
    [list.data, openGroupId, rows],
  );
  const railBotItems = useMemo<ReadonlyArray<RailBotItem>>(() => {
    const shown = railBots(shownInChats(summaries));
    const motions = shown.map(motionForSummary);
    const drawn = perfOptimizationOn("all-busy-motion")
      ? motions
      : firstContinuousMotionOnly(motions);
    const comets = new Set(
      cometRowIndexes(drawn, !perfOptimizationOn("anim-all")).map(
        (index) => shown[index]!.bot.botId,
      ),
    );
    return shown.map((summary, index) => {
      const liveThread = summary.liveThread ?? null;
      const entry = liveThread === null ? undefined : progressNotes.get(liveThread.id as string);
      const caption = railCaption({
        summary,
        now,
        needsYou: botsNeeding.has(summary.bot.botId),
        thinking:
          summary.thinking && !currentTurnHasToolStep(entry, liveThread === null ? {} : liveThread),
      });
      return {
        botId: summary.bot.botId,
        name: summary.bot.name,
        avatarShape: summary.bot.avatarShape,
        avatarColor: summary.bot.avatarColor,
        caption,
        // An idle tile keeps the plain avatar (see the rows above).
        motion: caption.tone === "idle" ? undefined : drawn[index],
        comet: comets.has(summary.bot.botId),
      };
    });
  }, [botsNeeding, now, progressNotes, summaries]);

  // --- Snoozed chats and groups, below the rows ---------------------------------------
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
  const sections = useMemo(
    () =>
      list.data === null
        ? { snoozed: [] }
        : buildChatSections({
            bots: list.data.bots,
            links: list.data.threads,
            shells,
            groups,
            relayThreadIds: memberThreadIds,
            nowMs: wakeClock,
          }),
    [groups, list.data, memberThreadIds, shells, wakeClock],
  );
  const memberNames = useCallback(
    (group: PersonalGroup) => memberBotsOf(group).map((bot) => bot.name),
    [memberBotsOf],
  );
  const snoozedRows = useMemo(
    () => sections.snoozed.filter((row) => sectionRowMatches(row, listQuery, memberNames)),
    [listQuery, memberNames, sections.snoozed],
  );
  const runBulk = useBulkChatActions(environmentId);
  const groupChatState = useGroupChatState(environmentId);
  const runSectionAction = async (task: () => Promise<string | null>) => {
    setSectionBusy(true);
    setSectionError(null);
    const failure = await task();
    setSectionBusy(false);
    setSectionError(failure);
  };
  const runChatAction = async (
    action: "wake",
    row: Extract<ChatSectionRow, { kind: "chat" }>,
  ): Promise<string | null> => {
    const outcome = await runBulk(action, [row.link.threadId], 0);
    return outcome.status === "settled" && outcome.anyFailed ? outcome.notice : null;
  };
  const sectionActions: ChatSectionActions = {
    onWake: (row) =>
      void runSectionAction(() =>
        row.kind === "chat" ? runChatAction("wake", row) : groupChatState.snooze(row.key, null),
      ),
  };
  // A rail card's Unpin: the same thread update the bot page's select mode sends.
  const unpinChat = (chat: RailChatItem) =>
    void runSectionAction(async () => {
      const outcome = await runBulk("unpin", [chat.threadId], 0);
      return outcome.status === "settled" && outcome.anyFailed ? outcome.notice : null;
    });
  const unpinGroup = (item: RailGroupItem) =>
    void runSectionAction(() => groupChatState.setPinned(item.groupId, false));
  // The rail is drawn again only when its items change (HomeRail), so it gets
  // handlers that keep their identity and always call the latest ones.
  const unpinRef = useRef({ unpinChat, unpinGroup });
  useLayoutEffect(() => {
    unpinRef.current = { unpinChat, unpinGroup };
  });
  const onUnpinChat = useCallback((chat: RailChatItem) => unpinRef.current.unpinChat(chat), []);
  const onUnpinGroup = useCallback((item: RailGroupItem) => unpinRef.current.unpinGroup(item), []);

  const visibleGroups = useMemo(
    () =>
      pinnedFirst(filterGroups(plainGroups(groups, wakeClock), listQuery, nameOf), isChatPinned),
    [groups, listQuery, nameOf, wakeClock],
  );
  const searchedArchivedGroups = useMemo(
    () => (listQuery.trim().length === 0 ? [] : filterGroups(archivedGroups, listQuery, nameOf)),
    [archivedGroups, listQuery, nameOf],
  );

  // --- Snapshot persistence -----------------------------------------------------------
  // Only what the cold paint draws: the rail's cards, then the All list as the
  // live screen orders it. Previews are never message text (see chatsSnapshot).
  const snapshotRows = useMemo<ChatsSnapshotRowInput[] | null>(() => {
    if (environmentId === null || list.data === null) return null;
    const ordered = [...railCards(rows), ...filterHomeRows(rows, "all")];
    return ordered.map((row) => {
      if (row.kind === "group") {
        const member = memberBotsOf(row.group)[0];
        return {
          botId: (member?.botId ?? "group") as string,
          name: row.group.name,
          avatarShape: member?.avatarShape ?? "blob",
          avatarColor: member?.avatarColor ?? "#64748B",
          subtitle: "",
          previewLabel: null,
          previewAtMs: row.activityMs,
          threadId: null,
          threadTitle: row.group.name,
          pinned: true,
        };
      }
      return {
        botId: row.bot.botId,
        name: row.bot.name,
        avatarShape: row.bot.avatarShape,
        avatarColor: row.bot.avatarColor,
        subtitle: row.bot.title,
        previewLabel: null,
        previewAtMs: row.activityMs,
        threadId: row.link.threadId as string,
        threadTitle: hidesBotPreviews(row.bot) ? null : row.title,
        pinned: row.pinned,
      };
    });
  }, [environmentId, list.data, memberBotsOf, rows]);
  const snapshotKey = snapshotRows === null ? null : JSON.stringify(snapshotRows);
  const lastPersistedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!onScreen) return;
    if (environmentId === null || snapshotRows === null || snapshotKey === null) return;
    if (lastPersistedKey.current === snapshotKey) return;
    lastPersistedKey.current = snapshotKey;
    writeChatsSnapshot(
      environmentId,
      buildChatsSnapshot({ environmentId, savedAtMs: Date.now(), rows: snapshotRows }),
    );
  }, [environmentId, onScreen, snapshotRows, snapshotKey]);

  // --- One list refetch per message boundary ------------------------------------------
  const previewKey = useMemo(
    () =>
      chatBases
        .map((base: HomeChatBase) => {
          const turn = base.shell.latestTurn;
          return `${base.key}=${[
            base.shell.latestUserMessageAt ?? "",
            turn?.turnId ?? "",
            turn?.state ?? "",
            turn?.assistantMessageId ?? "",
            turn?.completedAt ?? "",
          ].join(",")}`;
        })
        .join("|"),
    [chatBases],
  );
  const previewKeyRef = useRef<string | null>(null);
  const previewRefreshTimerRef = useRef<number | null>(null);
  const previewRefreshRef = useRef(list.refresh);
  const previewKeyReady = list.data !== null && shells.length > 0;
  useEffect(() => {
    previewRefreshRef.current = list.refresh;
    if (!previewKeyReady || !onScreen) return;
    if (previewKeyRef.current === null) {
      previewKeyRef.current = previewKey;
      return;
    }
    if (previewKeyRef.current === previewKey) return;
    const advanced = previewKeyAdvancedForChats(previewKeyRef.current, previewKey);
    previewKeyRef.current = previewKey;
    if (!advanced) return;
    if (previewRefreshTimerRef.current !== null) return;
    previewRefreshTimerRef.current = window.setTimeout(() => {
      previewRefreshTimerRef.current = null;
      previewRefreshRef.current();
    }, PREVIEW_REFRESH_DEBOUNCE_MS);
  }, [list, onScreen, previewKey, previewKeyReady]);
  useEffect(
    () => () => {
      if (previewRefreshTimerRef.current !== null) {
        window.clearTimeout(previewRefreshTimerRef.current);
        previewRefreshTimerRef.current = null;
      }
    },
    [],
  );

  // --- Keep the open chat's row on screen (desktop pane) ------------------------------
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
    if (shownRows.length === 0) return;
    const root = rootRef.current;
    if (root === null) return;
    const boundary = root.closest("aside");
    const reveal = (row: HTMLElement) => {
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
    };
    const found = root.querySelector<HTMLElement>("[data-sidebar-selected]");
    if (found !== null) {
      reveal(found);
      return;
    }
    // The open chat's row is outside the drawn slice (the list is windowed):
    // scroll the list to it, then reveal it once a frame has drawn it.
    const list = root.querySelector<HTMLElement>('[data-testid="home-rows"]');
    if (list === null) return;
    const scroller = findScrollParent(list);
    if (scroller === null) return;
    const index = shownRows.findIndex((candidate) =>
      candidate.kind === "chat" ? candidate.key === openThreadId : candidate.key === openGroupId,
    );
    if (index < 0) return;
    const hiddenAbove = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const delta = revealDelta(
      index * HOME_ROW_PITCH,
      (index + 1) * HOME_ROW_PITCH,
      hiddenAbove,
      hiddenAbove + scroller.clientHeight,
    );
    if (delta !== 0) scroller.scrollTop += delta;
    let frame = 0;
    let attempts = 0;
    const settle = () => {
      const row = root.querySelector<HTMLElement>("[data-sidebar-selected]");
      if (row !== null) {
        reveal(row);
        return;
      }
      if (attempts < 8) {
        attempts += 1;
        frame = requestAnimationFrame(settle);
      }
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [openGroupId, openThreadId, selectedChat, shownRows]);

  // --- Header, update line, usage -----------------------------------------------------
  const { label: versionLabel, updateAvailable } = useAppVersion();
  const [updatingApp, setUpdatingApp] = useState(false);
  const updateApp = useCallback(() => {
    if (updatingApp) return;
    setUpdatingApp(true);
    void reloadLatestApp();
  }, [updatingApp]);

  // Nothing at all to show: no bots, no groups, nothing snoozed (a bot whose
  // only chats are snoozed still has an empty list and a Snoozed section).
  const emptyAll =
    loaded &&
    (list.data?.bots.length ?? 0) === 0 &&
    groups.length === 0 &&
    archivedGroups.length === 0 &&
    sections.snoozed.length === 0;
  const filterLabel =
    listFilter === "needs"
      ? "Nothing needs you."
      : listFilter === "unread"
        ? "No unread chats."
        : listFilter === "groups"
          ? "No groups yet."
          : null;

  return (
    <div
      ref={rootRef}
      onClickCapture={(event) => {
        clickedRef.current = (event.target as Element).closest("a, button");
      }}
      className="flex min-h-full min-w-0 flex-col pb-6"
    >
      <header className="flex h-[52px] items-center pr-2 pl-4">
        <h1 className="text-3xl leading-9 font-extrabold tracking-[var(--personal-title-tracking)] text-[var(--personal-text)]">
          Bots
        </h1>
        <div className="ml-auto flex items-center">
          <button
            type="button"
            aria-label={searchOpen ? "Close search" : "Search chats"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((open) => {
                if (open) setQuery("");
                return !open;
              });
            }}
            className={ICON_BUTTON}
          >
            {searchOpen ? (
              <X aria-hidden="true" className="size-6" strokeWidth={1.75} />
            ) : (
              <Search aria-hidden="true" className="size-6" strokeWidth={1.75} />
            )}
          </button>
          <Link to="/bots/team" aria-label="Team" className={ICON_BUTTON}>
            <Network aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
          <Link to="/bots/settings" aria-label="Settings" className={ICON_BUTTON}>
            <Settings aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
          <button
            type="button"
            aria-label="New chat, pick a bot"
            onClick={() => setPickerOpen(true)}
            className={ICON_BUTTON_FILLED}
          >
            <Plus aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
          </button>
        </div>
      </header>

      {/* The update status line: nothing at all unless a release is moving or
          just landed, and it expands and collapses smoothly when it changes
          (UpdateStatusLine). */}
      <UpdateStatusLine versionLabel={versionLabel} />

      <PersonalUsageStrip now={now} />

      {searchOpen ? (
        <div className="px-4 pb-1">
          <div className="relative flex h-11 items-center">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 size-[18px] text-[var(--personal-text-secondary)]"
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search bots and chats"
              aria-label="Search bots and chats"
              className="h-11 w-full rounded-full border-0 bg-[var(--personal-fill-muted)] pr-4 pl-10 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            />
          </div>
        </div>
      ) : null}

      {environmentId === null ? (
        <p className="mt-6 px-4 text-[15px] text-[var(--personal-text-secondary)]">
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
        <div className="mx-4 mt-6 flex items-center justify-between gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
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

      {sectionError !== null ? (
        <p
          role="alert"
          className="mx-4 mt-4 rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] px-3.5 py-2.5 text-sm break-words text-[var(--personal-danger)]"
        >
          {sectionError}
        </p>
      ) : null}

      {emptyAll ? (
        <div className="mt-10 flex flex-col items-center gap-3 px-4 text-center">
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

      {loaded && !emptyAll ? (
        <>
          <HomeRail
            chats={railChatItems}
            groups={railGroupItems}
            bots={railBotItems}
            onUnpinChat={onUnpinChat}
            onUnpinGroup={onUnpinGroup}
            stage={stageMount}
          />
          <div className="px-4">
            <HomeFilters active={filter} onSelect={setFilter} needsCount={needsYou.count} />
          </div>

          {drawnRows.length > 0 ? (
            <HomeRowsList
              rows={drawnRows}
              previewByKey={previewByKey}
              motionByKey={motionByKey}
              cometKeys={cometKeys}
              now={lastShownRef.current?.now ?? now}
              openThreadId={openThreadId}
              openGroupId={openGroupId}
              memberBotsOf={memberBotsOf}
              nameOf={nameOf}
              onScreen={onScreen}
              stage={stageMount}
            />
          ) : listQuery.trim().length > 0 && snoozedRows.length === 0 ? (
            <p className="mt-6 px-4 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No bots or chats match "{listQuery.trim()}".
            </p>
          ) : filterLabel !== null ? (
            <p className="mt-6 px-4 text-center text-[15px] text-[var(--personal-text-secondary)]">
              {filterLabel}
            </p>
          ) : null}

          {/* The design's own note under the Needs you filter. */}
          {listFilter === "needs" && listQuery.trim().length === 0 ? (
            <p className="px-4 py-4 text-center text-[13px] leading-4 text-[var(--personal-text-secondary)]">
              Answered requests leave this list.
            </p>
          ) : null}

          {listQuery.trim().length > 0 ? (
            <MessageSearchResults
              environmentId={environmentId}
              query={listQuery}
              now={now}
              bots={list.data?.bots ?? []}
              groups={[...groups, ...archivedGroups]}
            />
          ) : null}

          <SnoozedChatList
            rows={snoozedRows}
            now={wakeClock}
            rounds={rounds}
            memberBotsOf={memberBotsOf}
            actions={sectionActions}
            busy={sectionBusy}
          />

          {listQuery.trim().length === 0 && archivedGroups.length > 0 ? (
            /* Like a bot's Archived chats: collapsed, at the bottom, one tap away. */
            <details className="mx-4 mt-6">
              <summary className="flex min-h-11 cursor-pointer items-center text-[15px] font-medium text-[var(--personal-text-secondary)]">
                Archived groups ({archivedGroups.length})
              </summary>
              <ul aria-label="Archived groups" className="home-rows">
                {archivedGroups.map((group) => (
                  <li key={group.groupId}>
                    <Link
                      to="/bots/groups/$groupId"
                      params={{ groupId: group.groupId }}
                      aria-label={`${group.name}, archived group chat`}
                      className="home-row flex h-[72px] items-center gap-3 px-4"
                    >
                      {memberBotsOf(group)[0] !== undefined ? (
                        <BotAvatar
                          shape={memberBotsOf(group)[0]!.avatarShape}
                          color={memberBotsOf(group)[0]!.avatarColor}
                          size={48}
                          label={group.name}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
                        {group.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-[var(--personal-fill-muted)] px-2 text-[12px] leading-5 font-medium text-[var(--personal-text-secondary)]">
                        Archived
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {loaded ? null : showingSnapshot && snapshot !== null ? (
        <SnapshotRows snapshot={snapshot} now={now} selectedChat={selectedChat} />
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

      <BotPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        environmentId={environmentId}
        bots={railBots(shownInChats(summaries))}
        now={now}
      />
    </div>
  );
}

/**
 * The rows, in their own component so they can be frozen: on the phone the
 * shell keeps this list mounted under an open chat (hidden), and a store
 * change while it is hidden would otherwise reconcile every row (59 of them)
 * for a screen nobody can see. The home hands this component the last props it
 * had while it was visible, so React skips the whole subtree until Back.
 *
 * The list is windowed (`homeWindow.ts`): of the 60 chats the fixture holds,
 * only the ones near the scroll position are drawn, with two spacer `<li>`s
 * keeping the list's height - and so the kept scroll position - exactly what
 * the full list's would be. Scroll position lives here, in this memo, so a
 * window shift on scroll re-renders these rows and nothing above them.
 */
const HomeRowsList = memo(function HomeRowsList({
  rows,
  previewByKey,
  motionByKey,
  cometKeys,
  now,
  openThreadId,
  openGroupId,
  memberBotsOf,
  nameOf,
  onScreen,
  stage,
}: {
  readonly rows: ReadonlyArray<HomeRow>;
  readonly previewByKey: ReadonlyMap<string, { text: string; tone: RowPreviewTone }>;
  readonly motionByKey: ReadonlyMap<string, AvatarMotion | undefined>;
  readonly cometKeys: ReadonlySet<string>;
  readonly now: number;
  readonly openThreadId: string | null;
  readonly openGroupId: string | null;
  readonly memberBotsOf: (group: PersonalGroup) => ReadonlyArray<PersonalBot>;
  readonly nameOf: (botId: string) => string | null;
  readonly onScreen: boolean;
  /** Mount the first slice in steps (a first launch with nothing saved to show). */
  readonly stage: boolean;
}): JSX.Element {
  const { listRef, range: windowRange } = useHomeWindow(rows.length, { active: onScreen });
  // The slice itself is drawn in steps while the list first mounts: the rows
  // the screen shows first, the overscan a few frames later.
  const stagedRows = useStagedCount(windowRange.end - windowRange.start, {
    enabled: stage,
    first: HOME_FIRST_ROWS,
    step: HOME_STEP_ROWS,
  });
  const range =
    stagedRows >= windowRange.end - windowRange.start
      ? windowRange
      : { start: windowRange.start, end: windowRange.start + stagedRows };
  const spacers = homeWindowSpacers(range, rows.length);
  const drawn =
    range.start === 0 && range.end === rows.length ? rows : rows.slice(range.start, range.end);
  return (
    <ul ref={listRef} aria-label="Your chats" data-testid="home-rows" className="home-rows">
      {spacers.above > 0 ? (
        <li aria-hidden="true" data-home-window-pad="" style={{ height: spacers.above }} />
      ) : null}
      {drawn.map((row, index) => {
        // The row's real place in the whole list, for a screen reader (the
        // drawn slice is not the list).
        const posInSet = range.start + index + 1;
        return row.kind === "chat" ? (
          <HomeChatRowView
            key={row.key}
            row={row}
            preview={previewByKey.get(row.key)?.text ?? ""}
            tone={previewByKey.get(row.key)?.tone ?? "plain"}
            now={now}
            selected={openThreadId === row.key}
            motion={motionByKey.get(row.key)}
            comet={cometKeys.has(row.key)}
            posInSet={posInSet}
            setSize={rows.length}
          />
        ) : (
          <HomeGroupRowView
            key={row.key}
            row={row}
            bots={memberBotsOf(row.group)}
            nameOf={nameOf}
            now={now}
            selected={openGroupId === row.group.groupId}
            posInSet={posInSet}
            setSize={rows.length}
          />
        );
      })}
      {spacers.below > 0 ? (
        <li aria-hidden="true" data-home-window-pad="" style={{ height: spacers.below }} />
      ) : null}
    </ul>
  );
});

/** The chat threads with an open request of one kind (the summary join). */
function threadIdsWithKind(model: NeedsYouModel, kind: "secret"): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, requests] of model.byRow) {
    if (requests.some((request) => request.kind === kind)) out.add(key);
  }
  return out;
}
