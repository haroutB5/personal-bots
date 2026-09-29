import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";

import {
  describePersonalRoutineTrigger,
  type PersonalBot,
  type PersonalRoutine,
  type PersonalTask,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Ellipsis, Plus } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import {
  allSelected,
  selectedCountLabel,
  toggleAllSelection,
  toggleSelection,
  visibleSelection,
} from "./bulkSelection";
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
import { ROUTINE_NOUN, useBulkDeleteRoutines, useBulkSetRoutinesEnabled } from "./useBulkDelete";
import { useLongPress } from "./useLongPress";
import { formatRelativeTime } from "./relativeTime";
import { routineTriggerStatusLabel } from "./routineHook";
import {
  mergeTaskLists,
  TASK_LIST_FILTERS,
  taskListCountNeedsAttention,
  taskListFor,
  taskStatusLabel,
  taskStatusTone,
  type TaskListFilter,
} from "./taskPresentation";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  personalTaskHistory,
  usePersonalRoutines,
  usePersonalTasks,
} from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import { useMinuteNow } from "./useMinuteNow";

const DOT_CLASS = {
  live: "bg-[var(--personal-live)]",
  review: "bg-[var(--personal-review)]",
  error: "bg-[var(--personal-error)]",
} as const;

export function StatusDot({
  tone,
}: {
  tone: "live" | "review" | "error" | "none";
}): JSX.Element | null {
  if (tone === "none") return null;
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${DOT_CLASS[tone]}`}
    />
  );
}

export function SmallBotAvatar({ bot }: { bot: PersonalBot | undefined }): JSX.Element {
  return bot === undefined ? (
    <span
      aria-hidden="true"
      className="size-[34px] shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
    />
  ) : (
    <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={34} label="" />
  );
}

const ROW_LINK =
  "flex min-h-16 items-center gap-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]";

function TaskRow({
  task,
  bot,
  parent,
  now,
}: {
  task: PersonalTask;
  bot: PersonalBot | undefined;
  parent: PersonalTask | undefined;
  now: number;
}): JSX.Element {
  const meta = [
    bot?.name ?? "Deleted bot",
    taskStatusLabel(task.status),
    parent !== undefined ? `for "${parent.title}"` : task.source === "routine" ? "Routine" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <li>
      <Link to="/tasks/$taskId" params={{ taskId: task.taskId }} className={ROW_LINK}>
        <SmallBotAvatar bot={bot} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold text-[var(--personal-text)]">
            {task.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
            <StatusDot tone={taskStatusTone(task.status)} />
            <span className="truncate">{meta}</span>
          </span>
        </span>
        <span className="shrink-0 self-start pt-0.5 text-[13px] text-[var(--personal-text-tertiary)]">
          {formatRelativeTime(DateTime.toEpochMillis(task.updatedAt), now)}
        </span>
      </Link>
    </li>
  );
}

function RoutineRowBody({
  routine,
  bot,
}: {
  routine: PersonalRoutine;
  bot: PersonalBot | undefined;
}): JSX.Element {
  return (
    <>
      <SmallBotAvatar bot={bot} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold text-[var(--personal-text)]">
          {routine.title}
        </span>
        <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
          {describePersonalRoutineTrigger(routine)}
        </span>
        <span className="truncate text-[13px] text-[var(--personal-text-tertiary)]">
          {routineTriggerStatusLabel(routine)}
        </span>
      </span>
    </>
  );
}

/** A routine in the list: tap to open, press and hold to start select mode with it picked. */
function RoutineRow({
  routine,
  bot,
  onLongPress,
}: {
  routine: PersonalRoutine;
  bot: PersonalBot | undefined;
  onLongPress: (routineId: string) => void;
}): JSX.Element {
  const routineId = routine.routineId;
  const longPress = useLongPress(
    useCallback(() => onLongPress(routineId), [onLongPress, routineId]),
  );
  return (
    <li>
      <div {...longPress} className={NO_TOUCH_SELECT}>
        <Link
          to="/tasks/routines/$routineId"
          params={{ routineId }}
          draggable={false}
          className={ROW_LINK}
        >
          <RoutineRowBody routine={routine} bot={bot} />
        </Link>
      </div>
    </li>
  );
}

/** A routine in select mode: the whole row toggles; no opening the routine. */
function SelectableRoutineRow({
  routine,
  bot,
  selected,
  onToggle,
}: {
  routine: PersonalRoutine;
  bot: PersonalBot | undefined;
  selected: boolean;
  onToggle: (routineId: string) => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={() => onToggle(routine.routineId)}
        className={cn(ROW_LINK, "w-full text-left", NO_TOUCH_SELECT)}
      >
        <SelectCheck checked={selected} />
        <RoutineRowBody routine={routine} bot={bot} />
      </button>
    </li>
  );
}

/** Finished tasks per "Show older tasks" tap. */
const OLDER_PAGE_SIZE = 30;

interface OlderTasks {
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

const NO_OLDER_TASKS: OlderTasks = { tasks: [], hasMore: true, loading: false, error: null };

const EMPTY_TEXT: Record<TaskListFilter, string> = {
  active: "Nothing is running right now.",
  waiting: "Nothing is waiting on you or another bot.",
  scheduled:
    "No routines yet. A routine gives a bot the same task on a schedule, or whenever an event fires.",
  completed: "Finished tasks will show up here.",
};

/**
 * /tasks: live task lists from personalTasks.subscribe, plus routines under
 * Scheduled. The feed carries the newest finished tasks; older ones load a
 * page at a time from personalTasks.history. Scheduled has the chat list's
 * select mode ("..." > Select routines, or press and hold a routine) for
 * bulk Pause, Resume and Delete.
 */
export function TasksScreen({ view }: { view: TaskListFilter }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const { tasks: taskFeed, error } = usePersonalTasks(environmentId);
  const loadHistory = useAtomCommand(personalTaskHistory, {
    label: "personal-tasks:history",
    reportFailure: false,
  });
  const [older, setOlder] = useState<OlderTasks>(NO_OLDER_TASKS);
  const tasks = useMemo(() => mergeTaskLists(taskFeed, older.tasks), [taskFeed, older.tasks]);
  const loadOlder = async () => {
    if (environmentId === null || older.loading) return;
    setOlder((current) => ({ ...current, loading: true, error: null }));
    // History is newest first, so the last task loaded is the page cursor.
    const last = older.tasks.at(-1);
    const outcome = await loadHistory({
      environmentId,
      input: { limit: OLDER_PAGE_SIZE, ...(last === undefined ? {} : { before: last.taskId }) },
    });
    setOlder((current) =>
      outcome._tag === "Success"
        ? {
            tasks: [...current.tasks, ...outcome.value.tasks],
            hasMore: outcome.value.hasMore,
            loading: false,
            error: null,
          }
        : {
            ...current,
            loading: false,
            error: commandFailureMessage(outcome, "Could not load older tasks."),
          },
    );
  };
  const routinesQuery = usePersonalRoutines(environmentId);
  const botsQuery = usePersonalBotsList(environmentId);
  const botById = useMemo(
    () => new Map<string, PersonalBot>((botsQuery.data?.bots ?? []).map((bot) => [bot.botId, bot])),
    [botsQuery.data],
  );
  const lists = useMemo(() => {
    const grouped: Record<Exclude<TaskListFilter, "scheduled">, Array<PersonalTask>> = {
      active: [],
      waiting: [],
      completed: [],
    };
    for (const task of tasks?.values() ?? []) grouped[taskListFor(task.status)].push(task);
    for (const list of Object.values(grouped)) {
      list.sort(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      );
    }
    return grouped;
  }, [tasks]);
  const routines = routinesQuery.data?.routines ?? [];
  const counts: Record<TaskListFilter, number> = {
    active: lists.active.length,
    waiting: lists.waiting.length,
    scheduled: routines.filter((routine) => routine.enabled).length,
    completed: lists.completed.length,
  };
  const now = useMinuteNow();
  const loading = view === "scheduled" ? routinesQuery.data === null : tasks === null;
  const loadError = view === "scheduled" ? routinesQuery.error : error;

  // Select mode covers the routines on screen, and only on Scheduled.
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useBulkNotice();
  const [bulkBusy, setBulkBusy] = useState(false);
  const deleteRoutines = useBulkDeleteRoutines(environmentId);
  const setRoutinesEnabled = useBulkSetRoutinesEnabled(environmentId);
  const picked = view === "scheduled" ? selection : null;
  const selecting = picked !== null;
  const shownIds = useMemo(
    () => routines.map((routine) => routine.routineId as string),
    [routines],
  );
  const chosen = picked === null ? [] : visibleSelection(picked, shownIds);
  const everySelected = picked !== null && allSelected(picked, shownIds);
  const chosenSet = new Set(chosen);
  const toPause = routines
    .filter((routine) => routine.enabled && chosenSet.has(routine.routineId))
    .map((routine) => routine.routineId as string);
  const toResume = routines
    .filter((routine) => !routine.enabled && chosenSet.has(routine.routineId))
    .map((routine) => routine.routineId as string);

  const enterSelect = useCallback(
    (first: string | null) => {
      setNotice(null);
      setSelection(new Set(first === null ? [] : [first]));
    },
    [setNotice],
  );
  const exitSelect = useCallback(() => setSelection(null), []);
  useEscapeToExit(selecting, exitSelect);
  const toggle = useCallback((routineId: string) => {
    setSelection((current) => (current === null ? current : toggleSelection(current, routineId)));
  }, []);

  const runBulk = async (action: "pause" | "resume" | "delete") => {
    const ids = action === "pause" ? toPause : action === "resume" ? toResume : chosen;
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    const outcome =
      action === "delete"
        ? await deleteRoutines(ids)
        : await setRoutinesEnabled(ids, action === "resume");
    setBulkBusy(false);
    if (outcome.status === "cancelled") return;
    setNotice({ text: outcome.notice, failed: outcome.anyFailed });
    // Done: back to the plain list. Refused routines stay selected for another try.
    setSelection(outcome.failedIds.length === 0 ? null : new Set(outcome.failedIds));
  };

  return (
    <div className={cn("flex min-h-full flex-col px-5", selecting ? null : "pb-8")}>
      {selecting ? (
        <SelectModeHeader
          label={selectedCountLabel(chosen.length, ROUTINE_NOUN)}
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
        <header className="flex h-14 items-center justify-between">
          <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">Tasks</h1>
          <div className="flex items-center gap-2">
            {view === "scheduled" && routines.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Routine list options"
                      className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                    />
                  }
                >
                  <Ellipsis aria-hidden="true" className="size-6" strokeWidth={1.75} />
                </MenuTrigger>
                <MenuPopup align="end" className="personal-app personal-menu min-w-48">
                  <MenuItem onClick={() => enterSelect(null)}>Select routines</MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
            <Link
              to="/tasks/routines/new"
              aria-label="New routine"
              className="flex size-11 items-center justify-center rounded-full bg-[var(--personal-primary)] text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]"
            >
              <Plus aria-hidden="true" className="size-[22px]" strokeWidth={2} />
            </Link>
          </div>
        </header>
      )}

      {selecting ? null : (
        <nav
          aria-label="Task lists"
          className="mt-3 grid h-11 grid-cols-4 gap-0.5 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] p-0.5"
        >
          {TASK_LIST_FILTERS.map((filter) => {
            const active = filter.id === view;
            return (
              <Link
                key={filter.id}
                to="/tasks"
                search={{ view: filter.id }}
                replace
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 items-center justify-center gap-[3px] rounded-lg text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] ${
                  active
                    ? "bg-[var(--personal-surface)] font-semibold text-[var(--personal-text)] shadow-[var(--personal-shadow-card)]"
                    : "text-[var(--personal-text-secondary)]"
                }`}
              >
                <span className="truncate">{filter.label}</span>
                {/* Every list shows its count, zero included, so the row reads at a glance. */}
                <span
                  className={`min-w-[18px] shrink-0 rounded-full px-[5px] text-center text-[11px] leading-[18px] font-semibold tabular-nums ${
                    active ? "bg-[var(--personal-fill-muted)]" : "bg-[var(--personal-surface)]"
                  } ${
                    counts[filter.id] > 0 && taskListCountNeedsAttention(filter.id)
                      ? "text-[var(--personal-text)]"
                      : "text-[var(--personal-text-secondary)]"
                  }`}
                >
                  {counts[filter.id]}
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      {view === "scheduled" ? <BulkNoticeLine notice={notice} /> : null}

      {loadError !== null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">{loadError}</p>
      ) : loading ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">Loading…</p>
      ) : view === "scheduled" ? (
        routines.length === 0 ? (
          <EmptyList text={EMPTY_TEXT.scheduled} withNewRoutine />
        ) : (
          <ul className="mt-2 divide-y divide-[var(--personal-border)]">
            {routines.map((routine) =>
              selecting ? (
                <SelectableRoutineRow
                  key={routine.routineId}
                  routine={routine}
                  bot={botById.get(routine.botId)}
                  selected={picked?.has(routine.routineId) ?? false}
                  onToggle={toggle}
                />
              ) : (
                <RoutineRow
                  key={routine.routineId}
                  routine={routine}
                  bot={botById.get(routine.botId)}
                  onLongPress={enterSelect}
                />
              ),
            )}
          </ul>
        )
      ) : lists[view].length === 0 ? (
        <EmptyList text={EMPTY_TEXT[view]} withNewRoutine={false} />
      ) : (
        <ul className="mt-2 divide-y divide-[var(--personal-border)]">
          {lists[view].map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              bot={botById.get(task.botId)}
              parent={task.parentTaskId === null ? undefined : tasks?.get(task.parentTaskId)}
              now={now}
            />
          ))}
        </ul>
      )}

      {view === "completed" && loadError === null && !loading && older.hasMore ? (
        <div className="flex flex-col items-center gap-2 pt-4">
          <button
            type="button"
            disabled={older.loading}
            aria-busy={older.loading}
            onClick={() => void loadOlder()}
            className="flex h-11 items-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-5 text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
          >
            {older.loading ? "Loading…" : "Show older tasks"}
          </button>
          {older.error !== null ? (
            <p role="alert" className="text-[13px] text-[var(--personal-danger)]">
              {older.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {selecting ? (
        <SelectModeActions>
          <div className="-ml-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runBulk("pause")}
              disabled={toPause.length === 0 || bulkBusy}
              aria-busy={bulkBusy}
              className={cn(SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
            >
              Pause
            </button>
            <button
              type="button"
              onClick={() => void runBulk("resume")}
              disabled={toResume.length === 0 || bulkBusy}
              aria-busy={bulkBusy}
              className={cn(SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
            >
              Resume
            </button>
          </div>
          <SelectModeDeleteButton
            disabled={chosen.length === 0}
            busy={bulkBusy}
            onClick={() => void runBulk("delete")}
          />
        </SelectModeActions>
      ) : null}
    </div>
  );
}

function EmptyList({
  text,
  withNewRoutine,
}: {
  text: string;
  withNewRoutine: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <p className="max-w-[280px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
        {text}
      </p>
      {withNewRoutine ? (
        <Link
          to="/tasks/routines/new"
          className="flex h-11 items-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]"
        >
          New routine
        </Link>
      ) : null}
    </div>
  );
}
