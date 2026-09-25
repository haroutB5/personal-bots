import type { JSX } from "react";
import { useMemo, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, NotebookPen, Pencil, Plus } from "lucide-react";

import { useThreadDetail, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { botThreadRows, type BotThreadRow } from "./botThreadRows";
import { commandFailureMessage } from "./commandFeedback";
import { isThreadLive, isThreadRateLimited, threadNeedsAttention } from "./botSummaries";
import { formatRelativeTime } from "./relativeTime";
import { useStartBotChat } from "./startBotChat";
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

const ICON_LINK =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

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

/**
 * One chat in the bot's list. Swipe left for Archive (Unarchive once
 * archived) and Delete; a tap opens the chat, or closes the row while it is
 * swiped open. Archived rows keep their buttons for mouse, keyboard and
 * VoiceOver; open chats have the same actions in the chat's own "..." menu.
 */
function ThreadRow({
  environmentId,
  botId,
  row,
  now,
  archived,
  onError,
}: {
  environmentId: EnvironmentId;
  botId: string;
  row: BotThreadRow;
  now: number;
  archived: boolean;
  onError: (message: string | null) => void;
}) {
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
  return (
    <li>
      <SwipeToDelete
        label={`Delete ${title}`}
        onDelete={onDelete}
        trailingActions={[
          archived
            ? { label: `Unarchive ${title}`, text: "Unarchive", run: () => setArchived(false) }
            : { label: `Archive ${title}`, text: "Archive", run: () => setArchived(true) },
        ]}
      >
        {archived ? (
          <div className="flex min-h-12 items-center gap-3 py-1">
            <ThreadRowContent row={row} now={now} />
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
        ) : (
          <Link
            to="/bots/$botId/$threadId"
            params={{ botId, threadId: row.link.threadId }}
            className="flex min-h-14 items-center gap-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
          >
            <ThreadRowContent row={row} now={now} />
          </Link>
        )}
      </SwipeToDelete>
    </li>
  );
}

/** /bots/$botId: the bot's chats, newest first, with "New chat" and archived chats. */
export function BotThreadsScreen({ botId }: { botId: string }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const navigate = useNavigate();
  const laptopOffline = useLaptopOffline();
  const list = usePersonalBotsList(environmentId);
  const shells = useThreadShells();
  const bot = list.data?.bots.find((candidate) => candidate.botId === botId) ?? null;
  const { start, starting } = useStartBotChat(environmentId, bot?.botId ?? null);
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
  });

  const rows = useMemo(
    () =>
      bot === null || list.data === null
        ? { active: [], archived: [] }
        : botThreadRows(
            bot.botId,
            list.data.threads,
            shells.filter((shell) => shell.environmentId === environmentId),
          ),
    [bot, environmentId, list.data, shells],
  );

  // Wrapup acts on the most recent non-archived chat (rows.active is newest
  // first): the same chat "New chat" would supersede.
  const newestThreadId = rows.active[0]?.link.threadId ?? null;
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
    bot?.modelSelection ?? null,
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
          {/* Stacked on the phone; side by side on desktop, where two
              full-width 800px slabs read as banners rather than buttons. */}
          <div className="mt-3 flex flex-col gap-3 md:flex-row">
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting}
              aria-busy={starting}
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

          {rows.active.length === 0 ? (
            <p className="mt-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No chats with {bot.name} yet.
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
                />
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
                  <ThreadRow
                    key={row.link.threadId}
                    environmentId={environmentId}
                    botId={bot.botId}
                    row={row}
                    now={now}
                    archived
                    onError={setActionError}
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
