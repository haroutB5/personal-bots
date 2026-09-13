import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus, Search, Settings } from "lucide-react";

import { useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";

import { BotRow } from "./BotRow";
import { buildBotSummaries, collectAttentionThreads, filterBotSummaries } from "./botSummaries";
import { greetingLine, teamStatusLine } from "./greeting";
import {
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";

const MINUTE_MS = 60_000;

/** Re-render once a minute so relative timestamps and the greeting stay true. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]";

/** ui-spec Screen 1: header, greeting, search, bot rows, review row. */
export function ChatsScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const profile = usePersonalProfile(environmentId);
  const allShells = useThreadShells();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const now = useMinuteClock();
  const [query, setQuery] = useState("");

  const shells = useMemo(
    () => allShells.filter((shell) => shell.environmentId === environmentId),
    [allShells, environmentId],
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
          }),
    [list.data, providers, shells],
  );
  const visible = useMemo(() => filterBotSummaries(summaries, query), [query, summaries]);
  const attention = useMemo(() => collectAttentionThreads(summaries), [summaries]);
  const runningCount = summaries.filter((summary) => summary.live).length;
  const loaded = list.data !== null;
  const firstAttention = attention[0] ?? null;
  const firstAttentionBot =
    firstAttention === null
      ? null
      : (summaries.find((summary) => summary.attentionThreads.includes(firstAttention))?.bot ??
        null);

  return (
    <div className="flex min-w-0 flex-col px-5 pb-6">
      <header className="flex h-14 items-center justify-between">
        <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">Bots</h1>
        <div className="flex items-center gap-4">
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

      <section className="mt-6" aria-live="polite">
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
                  <BotRow environmentId={environmentId!} summary={summary} now={now} />
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
    </div>
  );
}
