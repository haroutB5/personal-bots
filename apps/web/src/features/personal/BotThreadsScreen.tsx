import type { JSX } from "react";
import { useMemo, useState } from "react";

import type { EnvironmentId, PersonalBot, PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Pencil, Plus } from "lucide-react";

import { useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { isThreadLive, isThreadRateLimited, threadNeedsAttention } from "./botSummaries";
import { formatRelativeTime } from "./relativeTime";
import { useStartBotChat } from "./startBotChat";
import {
  personalBotArchiveThread,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "./usePersonalBots";

const ICON_LINK =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

interface BotThreadRow {
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
  readonly updatedMs: number;
}

function toRows(
  bot: PersonalBot,
  links: ReadonlyArray<PersonalBotThread>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): { active: BotThreadRow[]; archived: BotThreadRow[] } {
  const shellsById = new Map(shells.map((shell) => [shell.id as string, shell] as const));
  const rows = links.flatMap((link): BotThreadRow[] => {
    if (link.botId !== bot.botId) return [];
    const shell = shellsById.get(link.threadId);
    if (shell === undefined) return [];
    const parsed = Date.parse(shell.updatedAt);
    return [{ link, shell, updatedMs: Number.isNaN(parsed) ? 0 : parsed }];
  });
  const newestFirst = (left: BotThreadRow, right: BotThreadRow) => right.updatedMs - left.updatedMs;
  return {
    active: rows
      .filter((row) => row.link.archivedAt === null && row.shell.archivedAt === null)
      .toSorted(newestFirst),
    archived: rows.filter((row) => row.link.archivedAt !== null).toSorted(newestFirst),
  };
}

function ThreadRowContent({ row, now }: { row: BotThreadRow; now: number }) {
  const live = isThreadLive(row.shell);
  const needsYou = threadNeedsAttention(row.shell);
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--personal-text)]">
        {row.shell.title}
      </span>
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

function ArchivedRow({
  environmentId,
  row,
  now,
}: {
  environmentId: EnvironmentId;
  row: BotThreadRow;
  now: number;
}) {
  const archiveThread = useAtomCommand(personalBotArchiveThread);
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex min-h-12 items-center gap-3 py-1">
      <ThreadRowContent row={row} now={now} />
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await archiveThread({
            environmentId,
            input: { threadId: row.link.threadId, archived: false },
          });
          setBusy(false);
        }}
        className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 text-sm font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
      >
        Restore
      </button>
    </li>
  );
}

/** /bots/$botId: the bot's chats, newest first, with "New chat" and archived chats. */
export function BotThreadsScreen({ botId }: { botId: string }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const shells = useThreadShells();
  const bot = list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  const { start, starting } = useStartBotChat(environmentId, bot?.botId ?? null);
  const [now] = useState(() => Date.now());

  const rows = useMemo(
    () =>
      bot === null || list.data === null
        ? { active: [], archived: [] }
        : toRows(
            bot,
            list.data.threads,
            shells.filter((shell) => shell.environmentId === environmentId),
          ),
    [bot, environmentId, list.data, shells],
  );

  return (
    <div className="flex min-w-0 flex-col px-5 pb-8">
      <header className="flex h-16 items-center gap-3">
        <Link to="/bots" aria-label="Back to Bots" className={`-ml-3 ${ICON_LINK}`}>
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        {bot !== null ? (
          <>
            <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={48} label={bot.name} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[19px] leading-6 font-bold text-[var(--personal-text)]">
                {bot.name}
              </h1>
              {bot.title !== "" ? (
                <p className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                  {bot.title}
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
          </>
        ) : (
          <h1 className="text-[19px] font-bold text-[var(--personal-text)]">Chats</h1>
        )}
      </header>

      {list.data !== null && bot === null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          This bot no longer exists.{" "}
          <Link to="/bots" className="font-medium text-[var(--personal-text)] underline">
            Back to Bots
          </Link>
        </p>
      ) : null}

      {bot !== null && environmentId !== null ? (
        <>
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            aria-busy={starting}
            className="mt-3 flex h-11 items-center justify-center gap-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="size-5" strokeWidth={1.75} />
            New chat
          </button>

          {rows.active.length === 0 ? (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No chats with {bot.name} yet.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)]">
              {rows.active.map((row) => (
                <li key={row.link.threadId}>
                  <Link
                    to="/bots/$botId/$threadId"
                    params={{ botId: bot.botId, threadId: row.link.threadId }}
                    className="flex min-h-14 items-center gap-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
                  >
                    <ThreadRowContent row={row} now={now} />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {rows.archived.length > 0 ? (
            <details className="mt-6">
              <summary className="flex min-h-11 cursor-pointer items-center text-[15px] font-medium text-[var(--personal-text-secondary)]">
                Archived chats ({rows.archived.length})
              </summary>
              <ul className="divide-y divide-[var(--personal-border)]">
                {rows.archived.map((row) => (
                  <ArchivedRow
                    key={row.link.threadId}
                    environmentId={environmentId}
                    row={row}
                    now={now}
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
