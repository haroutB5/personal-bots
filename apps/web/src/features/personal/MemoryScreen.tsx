import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type PersonalBot,
  type PersonalMemoryEntry,
  PersonalTaskId,
  personalBotTeamLabel,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { ChevronLeft, Ellipsis, Search, Trash2 } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  allSelected,
  selectedCountLabel,
  toggleAllSelection,
  toggleSelection,
  visibleSelection,
} from "./bulkSelection";
import { commandFailureMessage } from "./commandFeedback";
import { feedbackLabel } from "./contextUsed";
import { MemoryContent } from "./MemoryContent";
import {
  appScopeChip,
  isNewBotPreference,
  memoryMetaLine,
  memorySourceLabel,
  memoryTextLookup,
  readMemoryLastSeen,
  writeMemoryLastSeen,
} from "./memoryPresentation";
import { MemoryTidySection, MemoryWaitingSection, ArchivedMemorySection } from "./MemoryTidyPanels";
import { RulesUsageCard } from "./RulesUsageCard";
import { mergeTaskLists } from "./taskPresentation";
import {
  personalMemoryDelete,
  personalMemoryFeedback,
  usePersonalMemory,
  usePersonalReplacedMemory,
  usePersonalTasks,
  usePersonalTasksByIds,
} from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import { useMinuteNow } from "./useMinuteNow";
import {
  BulkNoticeLine,
  NO_TOUCH_SELECT,
  SelectCheck,
  SelectModeActions,
  SelectModeDeleteButton,
  SelectModeHeader,
  useBulkNotice,
  useEscapeToExit,
} from "./SelectMode";
import { MEMORY_NOUN, useBulkDeleteMemories } from "./useBulkDelete";
import { useLongPress } from "./useLongPress";

const KIND_LABEL = {
  note: "Note",
  preference: "Preference",
  task_summary: "Task summary",
} as const;

function scopeLabel(entry: PersonalMemoryEntry, botById: Map<string, PersonalBot>): string {
  if (entry.scope === "shared") return "All bots";
  if (entry.scope === "team")
    return entry.scopeId === null ? "One team" : personalBotTeamLabel(entry.scopeId);
  if (entry.scope === "bot") return botById.get(entry.scopeId ?? "")?.name ?? "One bot";
  return "Project";
}

/** Scope pill, kind, text and where it came from: the same in a plain row and in select mode. */
function MemoryEntryBody({
  entry,
  scope,
  source,
  now,
  folded,
  isNew,
  onClearMark,
}: {
  /** Takes back the owner's "outdated" / "not relevant" mark (a plain row only). */
  onClearMark?: (() => void) | undefined;
  entry: PersonalMemoryEntry;
  scope: string;
  source: string;
  now: number;
  /** A preference a bot saved since this screen was last opened here. */
  isNew: boolean;
  /** Select mode: the whole row is one checkbox, so long text stays clamped with no Show more. */
  folded: boolean;
}): JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-[var(--personal-radius-pill)] bg-[var(--personal-fill-muted)] px-2 py-0.5 text-[12px] font-medium text-[var(--personal-text)]">
          {scope}
        </span>
        <span className="text-[12px] text-[var(--personal-text-secondary)]">
          {KIND_LABEL[entry.kind]}
        </span>
        {appScopeChip(entry) !== "" ? (
          <span className="rounded-[var(--personal-radius-pill)] border border-[var(--personal-border)] px-2 py-0.5 text-[12px] font-medium text-[var(--personal-text)]">
            {appScopeChip(entry)}
          </span>
        ) : null}
        {isNew ? (
          <span className="rounded-[var(--personal-radius-pill)] bg-[var(--personal-primary)] px-2 py-0.5 text-[12px] font-semibold text-[var(--personal-primary-text)]">
            New
          </span>
        ) : null}
        {entry.demoted != null ? (
          <span className="rounded-[var(--personal-radius-pill)] border border-[var(--personal-border)] px-2 py-0.5 text-[12px] font-medium text-[var(--personal-text)]">
            {feedbackLabel(entry.demoted)} · ranks lower
            {onClearMark !== undefined ? (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={onClearMark}
                  className="min-h-6 font-semibold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                >
                  Clear
                </button>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      {folded ? (
        <p className="mt-1.5 line-clamp-5 text-[15px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)]">
          {entry.content}
        </p>
      ) : (
        <MemoryContent content={entry.content} />
      )}
      <p className="mt-1 text-[12px] text-[var(--personal-text-tertiary)]">
        {memoryMetaLine(source, DateTime.toEpochMillis(entry.updatedAt), now)}
      </p>
    </div>
  );
}

/** One entry with its delete button; press and hold starts select mode with it picked. */
function MemoryRow({
  entry,
  scope,
  source,
  now,
  isNew,
  busy,
  onDelete,
  onLongPress,
}: {
  entry: PersonalMemoryEntry;
  scope: string;
  source: string;
  now: number;
  isNew: boolean;
  busy: boolean;
  onDelete: (entry: PersonalMemoryEntry) => void;
  onLongPress: (memoryId: string) => void;
}): JSX.Element {
  const memoryId = entry.memoryId;
  const longPress = useLongPress(useCallback(() => onLongPress(memoryId), [onLongPress, memoryId]));
  const sendFeedback = useAtomCommand(personalMemoryFeedback);
  const environmentId = usePersonalEnvironmentId();
  return (
    <li {...longPress} className={cn("flex items-start gap-2 py-3", NO_TOUCH_SELECT)}>
      <MemoryEntryBody
        entry={entry}
        scope={scope}
        source={source}
        now={now}
        isNew={isNew}
        folded={false}
        onClearMark={
          environmentId === null
            ? undefined
            : () => void sendFeedback({ environmentId, input: { memoryId, signal: "clear" } })
        }
      />
      <button
        type="button"
        aria-label="Delete this memory"
        disabled={busy}
        onClick={() => onDelete(entry)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
      >
        <Trash2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
      </button>
    </li>
  );
}

/** An entry in select mode: the whole row toggles. */
function SelectableMemoryRow({
  entry,
  scope,
  source,
  now,
  isNew,
  selected,
  onToggle,
}: {
  entry: PersonalMemoryEntry;
  scope: string;
  source: string;
  now: number;
  isNew: boolean;
  selected: boolean;
  onToggle: (memoryId: string) => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={() => onToggle(entry.memoryId)}
        className={cn(
          "flex w-full items-start gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]",
          NO_TOUCH_SELECT,
        )}
      >
        <span className="flex h-6 items-center">
          <SelectCheck checked={selected} />
        </span>
        <MemoryEntryBody
          entry={entry}
          scope={scope}
          source={source}
          now={now}
          isNew={isNew}
          folded
        />
      </button>
    </li>
  );
}

/**
 * /bots/settings/memory: what bots remember, with source, time and delete.
 * Select mode (the "..." menu, or press and hold an entry) deletes several
 * at once; Select all covers the entries on screen, so a search narrows it.
 */
export function MemoryScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const memory = usePersonalMemory(environmentId);
  const replaced = usePersonalReplacedMemory(environmentId);
  // When this screen was last opened on this device: bot-saved preferences
  // newer than that are marked New. Read once, then moved on to now.
  const [lastSeen] = useState(readMemoryLastSeen);
  useEffect(() => writeMemoryLastSeen(Date.now()), []);
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
  const replacedEntries = replaced.data?.entries ?? null;
  const visibleReplaced =
    replacedEntries === null || needle.length === 0
      ? replacedEntries
      : replacedEntries.filter((entry) => entry.content.toLowerCase().includes(needle));
  const memoryTexts = useMemo(
    () => memoryTextLookup(memory.data?.entries, replaced.data?.entries),
    [memory.data, replaced.data],
  );
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

  // Select mode covers the entries on screen: a search narrows what Select
  // all reaches, and an entry deleted elsewhere stops counting.
  const deleteEntries = useBulkDeleteMemories(environmentId);
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useBulkNotice();
  const [bulkBusy, setBulkBusy] = useState(false);
  const selecting = selection !== null;
  const shownIds = visible.map((entry) => entry.memoryId as string);
  const chosen = selection === null ? [] : visibleSelection(selection, shownIds);
  const everySelected = selection !== null && allSelected(selection, shownIds);

  const enterSelect = useCallback(
    (first: string | null) => {
      setNotice(null);
      setError(null);
      setSelection(new Set(first === null ? [] : [first]));
    },
    [setNotice],
  );
  const exitSelect = useCallback(() => setSelection(null), []);
  useEscapeToExit(selecting, exitSelect);
  const toggle = useCallback((memoryId: string) => {
    setSelection((current) => (current === null ? current : toggleSelection(current, memoryId)));
  }, []);

  const onBulkDelete = async () => {
    if (chosen.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    const outcome = await deleteEntries(chosen);
    setBulkBusy(false);
    if (outcome.status === "cancelled") return;
    setNotice({ text: outcome.notice, failed: outcome.anyFailed });
    // Done: back to the plain list. Refused entries stay selected for another try.
    setSelection(outcome.failedIds.length === 0 ? null : new Set(outcome.failedIds));
  };

  const sourceOf = (entry: PersonalMemoryEntry) =>
    memorySourceLabel(
      entry,
      (botId) => botById.get(botId)?.name,
      (taskId) => tasks?.get(taskId)?.title,
    );

  return (
    <div className={cn("flex flex-col px-5", selecting ? "min-h-full" : "pb-8")}>
      {selecting ? (
        <SelectModeHeader
          label={selectedCountLabel(chosen.length, MEMORY_NOUN)}
          everySelected={everySelected}
          canSelectAll={shownIds.length > 0}
          onCancel={exitSelect}
          onToggleAll={() =>
            setSelection((current) =>
              current === null ? current : toggleAllSelection(current, shownIds),
            )
          }
        />
      ) : (
        <header className="flex h-14 items-center gap-1">
          <Link
            to="/bots/settings"
            activeOptions={{ exact: true }}
            aria-label="Back to Settings"
            className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
          <h1 className="min-w-0 flex-1 text-[19px] font-bold text-[var(--personal-text)]">
            Memory
          </h1>
          {entries.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Memory list options"
                    className="-mr-3 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                  />
                }
              >
                <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
              </MenuTrigger>
              <MenuPopup align="end" className="personal-app personal-menu min-w-48">
                <MenuItem onClick={() => enterSelect(null)}>Select memories</MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </header>
      )}

      <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Bots save notes (facts, decisions, events) here on their own and say so in the chat, with
        Undo; a rule (preference) you state in a chat is saved at once, in your own words, with an
        Undo line there too. Finished tasks add short summaries. Shared entries (facts about you)
        reach every bot, team entries reach one team's bots, and bot entries reach one bot.
        Preferences go to every turn of the bots they reach, except a rule limited to one app, which
        is listed only in chats about that app (the rest get a one-line index); up to 6 notes and 6
        task summaries are picked by relevance. When a fact changes, the newer entry replaces the
        older one, which moves to Archived and can be restored. Deleting an entry stops bots
        receiving it; chat transcripts where it came up still contain the text.
      </p>

      {selecting ? null : <RulesUsageCard environmentId={environmentId} />}

      {selecting ? null : (
        <MemoryWaitingSection
          environmentId={environmentId}
          texts={memoryTexts}
          botName={(botId) => botById.get(botId)?.name}
        />
      )}

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

      <BulkNoticeLine notice={notice} />

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
          {visible.map((entry) =>
            selecting ? (
              <SelectableMemoryRow
                key={entry.memoryId}
                entry={entry}
                scope={scopeLabel(entry, botById)}
                source={sourceOf(entry)}
                now={now}
                isNew={isNewBotPreference(entry, lastSeen)}
                selected={selection.has(entry.memoryId)}
                onToggle={toggle}
              />
            ) : (
              <MemoryRow
                key={entry.memoryId}
                entry={entry}
                scope={scopeLabel(entry, botById)}
                source={sourceOf(entry)}
                now={now}
                isNew={isNewBotPreference(entry, lastSeen)}
                busy={busyId === entry.memoryId}
                onDelete={(target) => void onDelete(target)}
                onLongPress={enterSelect}
              />
            ),
          )}
        </ul>
      )}

      {selecting ? null : (
        <>
          <ArchivedMemorySection
            environmentId={environmentId}
            entries={visibleReplaced}
            totalCount={replacedEntries?.length ?? 0}
            loadError={replaced.error}
            scopeOf={(entry) => scopeLabel(entry, botById)}
            now={now}
          />
          <MemoryTidySection
            environmentId={environmentId}
            texts={memoryTexts}
            botName={(botId) => botById.get(botId)?.name}
          />
        </>
      )}

      {selecting ? (
        <SelectModeActions>
          <SelectModeDeleteButton
            disabled={chosen.length === 0}
            busy={bulkBusy}
            onClick={() => void onBulkDelete()}
          />
        </SelectModeActions>
      ) : null}
    </div>
  );
}
