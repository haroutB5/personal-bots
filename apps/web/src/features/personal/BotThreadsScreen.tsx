import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, Ellipsis, NotebookPen, Pencil, Plus } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { useThreadDetail, useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { botModelShortLabel } from "./botModelLabel";
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
import {
  allChatsSelected,
  type BulkChatAction,
  type ChatSection,
  selectedCountLabel,
  toggleChatSelection,
  visibleSelection,
} from "./chatSelection";
import { useBulkChatActions } from "./useBulkChatActions";
import { useLongPress } from "./useLongPress";
import { usePersonalBackTarget } from "./usePersonalBackTarget";

const ICON_LINK =
  "flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

const TEXT_BUTTON =
  "flex h-11 shrink-0 items-center rounded-[var(--personal-radius-button)] px-2 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

// A hold on a row enters select mode, so it must not also start iOS text
// selection on the title or its link preview.
const NO_TOUCH_SELECT = "select-none [-webkit-touch-callout:none]";

/** The round check at the left of a row in select mode. */
function SelectCheck({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center rounded-full border-2",
        checked
          ? "border-[var(--personal-primary)] bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
          : "border-[var(--personal-text-tertiary)]",
      )}
    >
      {checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
    </span>
  );
}

/** A row in select mode: the whole row toggles; no swipe, no opening the chat. */
function SelectableThreadRow({
  row,
  now,
  selected,
  onToggle,
}: {
  row: BotThreadRow;
  now: number;
  selected: boolean;
  onToggle: (threadId: string) => void;
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
        <ThreadRowContent row={row} now={now} />
      </button>
    </li>
  );
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

/**
 * One chat in the bot's list. Swipe left for Archive (Unarchive once
 * archived) and Delete; a tap opens the chat, or closes the row while it is
 * swiped open. Archived rows keep their buttons for mouse, keyboard and
 * VoiceOver; open chats have the same actions in the chat's own "..." menu.
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
}: {
  environmentId: EnvironmentId;
  botId: string;
  row: BotThreadRow;
  now: number;
  archived: boolean;
  onError: (message: string | null) => void;
  /** Press and hold: select mode, starting with this chat. */
  onLongPress: (threadId: string) => void;
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
          <div
            {...longPress}
            className={cn("flex min-h-12 items-center gap-3 py-1", NO_TOUCH_SELECT)}
          >
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
          <div {...longPress} className={NO_TOUCH_SELECT}>
            <Link
              to="/bots/$botId/$threadId"
              params={{ botId, threadId: row.link.threadId }}
              draggable={false}
              className="flex min-h-14 items-center gap-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              <ThreadRowContent row={row} now={now} />
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
  const modelLabel = bot === null ? null : botModelShortLabel(bot.modelSelection, providers);
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

  // Select mode: one section at a time, so Select all never reaches the other.
  const [selection, setSelection] = useState<{
    readonly section: ChatSection;
    readonly ids: ReadonlySet<string>;
  } | null>(null);
  const [notice, setNotice] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
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

  // Escape leaves select mode, as Cancel does.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  // A plain result fades after a while; one with failures stays until the next action.
  useEffect(() => {
    if (notice === null || notice.failed) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const onBulk = async (action: BulkChatAction) => {
    if (selection === null || chosen.length === 0 || bulkBusy) return;
    const section = selection.section;
    const working = sectionRows.filter(
      (row) => chosen.includes(row.link.threadId) && isThreadLive(row.shell),
    ).length;
    setBulkBusy(true);
    const outcome = await runBulk(action, chosen, working);
    setBulkBusy(false);
    if (outcome.status === "cancelled") return;
    setNotice({ text: outcome.notice, failed: outcome.anyFailed });
    // Done: back to the plain list. Refused chats stay selected for another try.
    setSelection(
      outcome.failedIds.length === 0 ? null : { section, ids: new Set(outcome.failedIds) },
    );
  };

  const noticeLine =
    notice !== null ? (
      <p
        role={notice.failed ? "alert" : "status"}
        className={cn(
          "mt-3 text-center text-sm",
          notice.failed ? "text-[var(--personal-error)]" : "text-[var(--personal-text-secondary)]",
        )}
      >
        {notice.text}
      </p>
    ) : null;

  const renderSelectable = (row: BotThreadRow) => (
    <SelectableThreadRow
      key={row.link.threadId}
      row={row}
      now={now}
      selected={selection?.ids.has(row.link.threadId) ?? false}
      onToggle={toggle}
    />
  );

  return (
    <div className={cn("flex min-w-0 flex-col px-5", selecting ? "min-h-full" : "pb-8")}>
      {selecting ? (
        <header className="flex h-16 items-center gap-2">
          <button
            type="button"
            onClick={() => setSelection(null)}
            className={cn("-ml-2", TEXT_BUTTON, "font-normal text-[var(--personal-text)]")}
          >
            Cancel
          </button>
          <h1
            aria-live="polite"
            className="min-w-0 flex-1 truncate text-center text-[17px] font-bold text-[var(--personal-text)] tabular-nums"
          >
            {selectedCountLabel(chosen.length)}
          </h1>
          <button
            type="button"
            onClick={toggleAll}
            disabled={sectionIds.length === 0}
            className={cn("-mr-2", TEXT_BUTTON, "text-[var(--personal-text)]")}
          >
            {everySelected ? "Deselect all" : "Select all"}
          </button>
        </header>
      ) : (
        <header className="flex h-16 items-center gap-3">
          <Link to={backTarget.to} aria-label={backTarget.label} className={`-ml-3 ${ICON_LINK}`}>
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
          <Link to={backTarget.to} className="font-medium text-[var(--personal-text)] underline">
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
          {/* Pinned to the bottom of the screen, above the home indicator. */}
          <div
            className="sticky bottom-0 -mx-5 mt-auto flex items-center justify-between border-t border-[var(--personal-border)] bg-[var(--personal-bg)] px-5 pt-2"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
          >
            <button
              type="button"
              onClick={() =>
                void onBulk(selection.section === "archived" ? "unarchive" : "archive")
              }
              disabled={chosen.length === 0 || bulkBusy}
              aria-busy={bulkBusy}
              className={cn("-ml-2", TEXT_BUTTON, "text-[var(--personal-text)]")}
            >
              {selection.section === "archived" ? "Unarchive" : "Archive"}
            </button>
            <button
              type="button"
              onClick={() => void onBulk("delete")}
              disabled={chosen.length === 0 || bulkBusy}
              aria-busy={bulkBusy}
              className={cn("-mr-2", TEXT_BUTTON, "text-[var(--personal-error)]")}
            >
              Delete
            </button>
          </div>
        </>
      ) : null}

      {bot !== null && environmentId !== null && selection === null ? (
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
          {noticeLine}

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
                  onLongPress={selectFromActive}
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
