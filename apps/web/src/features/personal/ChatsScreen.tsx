import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import type { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Network, Plus, Search, Settings } from "lucide-react";

import { useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";

import { BotAvatar } from "./BotAvatar";
import { BotRow, previewOf, ROW_CLASS } from "./BotRow";
import {
  buildBotSummaries,
  collectAttentionThreads,
  filterBotSummaries,
  providerLine,
} from "./botSummaries";
import {
  buildChatsSnapshot,
  readChatsSnapshot,
  writeChatsSnapshot,
  type ChatsSnapshot,
  type ChatsSnapshotRowInput,
} from "./chatsSnapshot";
import {
  resolveTurnChildren,
  type ServerTurn,
  serverTurnLabel,
  waitingLabelsByThread,
} from "./delegationModel";
import { useAppVersion } from "./appVersion";
import { greetingLine, teamStatusLine } from "./greeting";
import { SwipeToDelete } from "./SwipeToDelete";
import { useDeleteBot } from "./useDeleteBot";
import { usePersonalTasks } from "./usePersonalAutomation";
import { PersonalUsageStrip } from "./PersonalUsageStrip";
import { useRefreshBotsForTaskThreads } from "./useRefreshBotsForTaskThreads";
import {
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";
import { formatRelativeTime } from "./relativeTime";

const MINUTE_MS = 60_000;

/** Re-render once a minute so relative timestamps and the greeting stay true. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]";

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
function SnapshotBotRows({ snapshot, now }: { snapshot: ChatsSnapshot; now: number }): JSX.Element {
  return (
    <ul
      aria-label="Your bots"
      className="mt-3 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]"
    >
      {snapshot.rows.map((row) => {
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
                {row.providerLabel}
              </span>
              <span className="truncate text-sm leading-5 text-[#3a3a3a]">{row.preview}</span>
            </span>
          </>
        );
        return (
          <li key={row.botId}>
            {row.threadId !== null ? (
              <Link
                to="/bots/$botId/$threadId"
                params={{
                  botId: row.botId as PersonalBotId,
                  threadId: row.threadId as ThreadId,
                }}
                className={ROW_CLASS}
              >
                {content}
              </Link>
            ) : (
              <div className={ROW_CLASS}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** ui-spec Screen 1: header, greeting, search, bot rows, review row. */
export function ChatsScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const profile = usePersonalProfile(environmentId);
  const allShells = useThreadShells();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const now = useMinuteClock();
  const deleteBot = useDeleteBot(environmentId);
  const [query, setQuery] = useState("");

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
  const showingSnapshot = !loaded && snapshot !== null && snapshot.rows.length > 0;
  const firstPaintReady = loaded || showingSnapshot || list.error !== null;
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
  const summaries = useMemo(
    () =>
      list.data === null
        ? []
        : buildBotSummaries({
            bots: list.data.bots,
            links: list.data.threads,
            shells,
            providers,
            waitingByThread,
          }),
    [list.data, providers, shells, waitingByThread],
  );
  // Previews ride on `personalBots.list`; a message landing on a bot's newest
  // thread bumps that shell's updatedAt (already live), which refetches the
  // list once instead of every row holding a full thread subscription.
  const previewKey = summaries.map((summary) => summary.newestThread?.updatedAt ?? "").join("|");
  const previewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (previewKeyRef.current === null) {
      previewKeyRef.current = previewKey;
      return;
    }
    if (previewKeyRef.current === previewKey) return;
    previewKeyRef.current = previewKey;
    list.refresh();
  }, [list, previewKey]);
  const visible = useMemo(() => filterBotSummaries(summaries, query), [query, summaries]);
  const attention = useMemo(() => collectAttentionThreads(summaries), [summaries]);
  const runningCount = summaries.filter((summary) => summary.live).length;
  const firstAttention = attention[0] ?? null;
  const versionLabel = useAppVersion();
  const firstAttentionBot =
    firstAttention === null
      ? null
      : (summaries.find((summary) => summary.attentionThreads.includes(firstAttention))?.bot ??
        null);

  // Persist the render snapshot after each successful list fetch. The effect
  // only writes when the row content actually changed, so task-feed updates
  // that leave the rows alone cost nothing.
  const snapshotRows = useMemo<ChatsSnapshotRowInput[] | null>(() => {
    if (environmentId === null || list.data === null) return null;
    return summaries.map((summary) => ({
      botId: summary.bot.botId,
      name: summary.bot.name,
      avatarShape: summary.bot.avatarShape,
      avatarColor: summary.bot.avatarColor,
      providerLabel: providerLine(summary.provider),
      preview: previewOf(summary, describeTurn),
      previewAtMs: summary.lastActivityMs,
      threadId: summary.newestThread === null ? null : (summary.newestThread.id as string),
      threadTitle: summary.newestThread === null ? null : summary.newestThread.title,
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

  return (
    <div className="flex min-h-full min-w-0 flex-col px-5 pb-6">
      <header className="flex h-14 items-center justify-between">
        <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">Bots</h1>
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
          <Link
            to="/bots/new"
            aria-label="New bot"
            className={`${ICON_BUTTON} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
          >
            <Plus aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
          </Link>
        </div>
      </header>

      <PersonalUsageStrip now={now} />

      <section className="mt-4" aria-live="polite">
        <p className="text-2xl leading-8 font-bold tracking-[-0.3px] text-[var(--personal-text)]">
          {greetingLine(new Date(now), profile.data?.displayName ?? "")}
        </p>
        {loaded ? (
          <p className="mt-1 text-[18px] leading-6 text-[var(--personal-text-secondary)]">
            {teamStatusLine({
              botCount: summaries.length,
              runningCount,
              reviewCount: attention.length,
            })}
          </p>
        ) : null}
      </section>

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
          <p className="min-w-0 text-[15px] text-[var(--personal-text)]">
            Couldn't load your bots. {list.error}
          </p>
          <button
            type="button"
            onClick={list.refresh}
            className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-medium text-[var(--personal-text)]"
          >
            Try again
          </button>
        </div>
      ) : null}

      {loaded && summaries.length === 0 ? (
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

      {loaded && summaries.length > 0 ? (
        <>
          <div className="relative mt-4">
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

          {visible.length > 0 ? (
            <ul className="mt-3 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]">
              {visible.map((summary) => (
                <li key={summary.bot.botId}>
                  <SwipeToDelete
                    label={`Delete ${summary.bot.name}`}
                    onDelete={() => deleteBot(summary.bot)}
                  >
                    <BotRow
                      environmentId={environmentId!}
                      summary={summary}
                      now={now}
                      describeTurn={describeTurn}
                    />
                  </SwipeToDelete>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No bots or chats match "{query.trim()}".
            </p>
          )}

          {firstAttention !== null && firstAttentionBot !== null ? (
            <Link
              to="/bots/$botId/$threadId"
              params={{ botId: firstAttentionBot.botId, threadId: firstAttention.id }}
              className="mt-3 flex h-[50px] items-center gap-3 rounded-xl border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] px-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full bg-[var(--personal-review)]"
              />
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--personal-text)]">
                {attention.length === 1
                  ? "1 item needs your review"
                  : `${attention.length} items need your review`}
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
        <SnapshotBotRows snapshot={snapshot} now={now} />
      ) : list.error === null ? (
        <ChatsSkeletonRows />
      ) : null}

      {versionLabel !== null ? (
        <div className="mt-auto pt-8">
          <p className="text-center text-[11px] leading-4 text-[var(--personal-text-secondary)]">
            Bots {versionLabel}
          </p>
        </div>
      ) : null}
    </div>
  );
}
