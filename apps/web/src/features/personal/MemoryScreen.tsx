import type { JSX } from "react";
import { useMemo, useState } from "react";

import { type PersonalBot, type PersonalMemoryEntry, PersonalTaskId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { ChevronLeft, Search, Trash2 } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { formatRelativeTime } from "./relativeTime";
import { mergeTaskLists } from "./taskPresentation";
import {
  personalMemoryDelete,
  usePersonalMemory,
  usePersonalTasks,
  usePersonalTasksByIds,
} from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import { useMinuteNow } from "./useMinuteNow";

const KIND_LABEL = {
  note: "Note",
  preference: "Preference",
  task_summary: "Task summary",
} as const;

/** Where an entry came from, in words. */
export function memorySourceLabel(
  entry: Pick<PersonalMemoryEntry, "source">,
  botName: (botId: string) => string | undefined,
  taskTitle: (taskId: string) => string | undefined,
): string {
  if (entry.source === "user") return "Saved by you";
  if (entry.source.startsWith("bot:")) {
    return `Saved by ${botName(entry.source.slice(4)) ?? "a bot"} when you asked`;
  }
  if (entry.source.startsWith("task:")) {
    const title = taskTitle(entry.source.slice(5));
    return title === undefined ? "From a finished task" : `From the task "${title}"`;
  }
  return entry.source;
}

function scopeLabel(entry: PersonalMemoryEntry, botById: Map<string, PersonalBot>): string {
  if (entry.scope === "shared") return "All bots";
  if (entry.scope === "bot") return botById.get(entry.scopeId ?? "")?.name ?? "One bot";
  return "Project";
}

/** /bots/settings/memory: what bots remember, with source, time and delete. */
export function MemoryScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const memory = usePersonalMemory(environmentId);
  const botsQuery = usePersonalBotsList(environmentId);
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const deleteEntry = useAtomCommand(personalMemoryDelete);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const botById = useMemo(
    () => new Map<string, PersonalBot>((botsQuery.data?.bots ?? []).map((bot) => [bot.botId, bot])),
    [botsQuery.data],
  );
  const entries = memory.data?.entries ?? [];
  // A memory can come from a task older than the feed carries: fetch the
  // titles the feed does not have.
  const missingTaskIds = useMemo(() => {
    if (taskFeed === null) return [];
    const ids = new Set<PersonalTaskId>();
    for (const entry of memory.data?.entries ?? []) {
      if (!entry.source.startsWith("task:")) continue;
      const taskId = PersonalTaskId.make(entry.source.slice(5));
      if (!taskFeed.has(taskId)) ids.add(taskId);
    }
    return [...ids].toSorted();
  }, [memory.data, taskFeed]);
  // Often more than the server's 100 ids per request: batched.
  const sourceTasks = usePersonalTasksByIds(environmentId, missingTaskIds);
  const tasks = useMemo(() => mergeTaskLists(taskFeed, sourceTasks), [taskFeed, sourceTasks]);
  const needle = query.trim().toLowerCase();
  const visible =
    needle.length === 0
      ? entries
      : entries.filter((entry) => entry.content.toLowerCase().includes(needle));
  const now = useMinuteNow();

  const onDelete = async (entry: PersonalMemoryEntry) => {
    if (environmentId === null) return;
    const message =
      "Delete this memory?\nBots stop receiving it. Chats where it was mentioned still contain the text.";
    const confirmed =
      (await requestConfirmDialog(message, {
        variant: "destructive",
        confirmLabel: "Delete memory",
      })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusyId(entry.memoryId);
    const result = await deleteEntry({ environmentId, input: { memoryId: entry.memoryId } });
    setBusyId(null);
    setError(commandFailureMessage(result, "Could not delete that memory."));
  };

  return (
    <div className="flex flex-col px-5 pb-8">
      <header className="flex h-14 items-center gap-1">
        <Link
          to="/bots/settings"
          aria-label="Back to Settings"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="text-[19px] font-bold text-[var(--personal-text)]">Memory</h1>
      </header>

      <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Bots save something here only when you ask them to remember it, plus short summaries of
        finished tasks. Up to 8 relevant entries are given to a bot when it starts work. Deleting an
        entry stops bots receiving it; chat transcripts where it came up still contain the text.
      </p>

      <label className="mt-4 flex h-11 items-center gap-2.5 rounded-[var(--personal-radius-pill)] bg-[var(--personal-fill-muted)] px-3.5">
        <Search
          aria-hidden="true"
          className="size-[18px] text-[var(--personal-text-secondary)]"
          strokeWidth={1.75}
        />
        <span className="sr-only">Search memory</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memory"
          className="min-w-0 flex-1 bg-transparent text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)]"
        />
      </label>

      {error !== null ? (
        <p role="alert" className="mt-3 text-[14px] text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}

      {memory.data === null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          {memory.error ?? "Loading…"}
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-10 text-center text-[15px] text-[var(--personal-text-secondary)]">
          {entries.length === 0
            ? 'Nothing saved yet. Ask a bot to "remember" something.'
            : "No memory matches that search."}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--personal-border)]">
          {visible.map((entry) => (
            <li key={entry.memoryId} className="flex items-start gap-2 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-[var(--personal-radius-pill)] bg-[var(--personal-fill-muted)] px-2 py-0.5 text-[12px] font-medium text-[var(--personal-text)]">
                    {scopeLabel(entry, botById)}
                  </span>
                  <span className="text-[12px] text-[var(--personal-text-secondary)]">
                    {KIND_LABEL[entry.kind]}
                  </span>
                </div>
                <MemoryContent content={entry.content} />
                <p className="mt-1 text-[12px] text-[var(--personal-text-tertiary)]">
                  {memorySourceLabel(
                    entry,
                    (botId) => botById.get(botId)?.name,
                    (taskId) => tasks?.get(taskId)?.title,
                  )}{" "}
                  · {formatRelativeTime(DateTime.toEpochMillis(entry.updatedAt), now)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Delete this memory"
                disabled={busyId === entry.memoryId}
                onClick={() => void onDelete(entry)}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
              >
                <Trash2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Past this many characters an entry is folded to five lines. */
const MEMORY_FOLD_CHARS = 280;

/**
 * One entry's text. A wrap-up summary runs to 30 lines, and unfolded it
 * filled the phone screen on its own, so long entries open folded with a
 * "Show more" to read the rest in place.
 */
function MemoryContent({ content }: { readonly content: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = content.length > MEMORY_FOLD_CHARS;
  return (
    <>
      <p
        className={`mt-1.5 text-[15px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)] ${
          long && !open ? "line-clamp-5" : ""
        }`}
      >
        {content}
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="-my-2 min-h-11 rounded-[var(--personal-radius-button)] text-[14px] font-medium text-[var(--personal-text)] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}
