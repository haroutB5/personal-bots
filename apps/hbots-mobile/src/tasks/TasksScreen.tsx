import {
  mergeTaskLists,
  TASK_LIST_FILTERS,
  taskListCountNeedsAttention,
  taskStatusTone,
  type TaskListFilter,
} from "@hbots/personal-client/conversation/taskPresentation";
import {
  bulkDeleteConfirmLabel,
  bulkDeleteRoutinesConfirmMessage,
  bulkResultNotice,
  DELETE_VERB,
  PAUSE_VERB,
  ROUTINE_NOUN,
  RESUME_VERB,
  selectedCountLabel,
  toggleAllSelection,
  toggleSelection,
  visibleSelection,
} from "@hbots/personal-client/lists/bulkSelection";
import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import {
  describePersonalRoutineTrigger,
  PERSONAL_ROUTINES_BATCH_MAX,
  PersonalRoutineId,
  type PersonalBot,
  type PersonalRoutine,
  type PersonalTask,
} from "@t3tools/contracts";
import { IconDots, IconPlus } from "@tabler/icons-react-native";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { confirmDestructive } from "../components/confirmDestructive";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetAction, SheetShell } from "../sheets/SheetShell";
import { routineTriggerStatusLabel } from "@hbots/personal-client/routines/routineHook";
import { tokens } from "../shell/tokens";
import {
  botsById,
  routineBulkTargets,
  TASK_EMPTY_TEXT,
  taskBuckets,
  taskListCounts,
  taskRowMeta,
  tasksScreenState,
} from "./tasksModel";
import { WorkScreen } from "../work/WorkScreen";
import { EmptyText, ScreenScroll, SmallBotAvatar, StatusDot, TaskButton } from "./TaskUi";

const OLDER_PAGE_SIZE = 30;

interface OlderTasks {
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

const NO_OLDER_TASKS: OlderTasks = { tasks: [], hasMore: true, loading: false, error: null };

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Segment({
  label,
  count,
  active,
  attention,
  onPress,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly attention: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count}`}
      style={[styles.segment, active ? styles.segmentActive : null]}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        style={[styles.segmentLabel, active ? styles.segmentLabelActive : null]}
      >
        {label}
      </Text>
      <View style={[styles.countPill, active ? styles.countPillActive : null]}>
        <Text
          maxFontSizeMultiplier={1.3}
          style={[styles.countText, count > 0 && attention ? styles.countTextAttention : null]}
        >
          {count}
        </Text>
      </View>
    </Pressable>
  );
}

function TaskRow({
  task,
  bot,
  parentTitle,
  now,
  onPress,
}: {
  readonly task: PersonalTask;
  readonly bot: PersonalBot | undefined;
  readonly parentTitle: string | null;
  readonly now: number;
  readonly onPress: () => void;
}) {
  const botName = bot?.name ?? null;
  const updatedAt = DateTime.toEpochMillis(task.updatedAt);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${taskRowMeta(task, botName, parentTitle)}`}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={styles.row}
    >
      <SmallBotAvatar bot={bot} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {task.title}
        </Text>
        <View style={styles.rowMetaLine}>
          <StatusDot tone={taskStatusTone(task.status)} />
          <Text style={styles.rowMeta} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {taskRowMeta(task, botName, parentTitle)}
          </Text>
        </View>
      </View>
      <Text style={styles.rowTime} maxFontSizeMultiplier={1.3}>
        {formatRelativeTime(updatedAt, now)}
      </Text>
    </Pressable>
  );
}

function RoutineRow({
  routine,
  bot,
  selected,
  selecting,
  onPress,
  onLongPress,
}: {
  readonly routine: PersonalRoutine;
  readonly bot: PersonalBot | undefined;
  readonly selected: boolean;
  readonly selecting: boolean;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole={selecting ? "checkbox" : "button"}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`${routine.title}, ${describePersonalRoutineTrigger(routine)}, ${routineTriggerStatusLabel(routine)}`}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={styles.row}
    >
      {selecting ? <Check checked={selected} /> : null}
      <SmallBotAvatar bot={bot} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {routine.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {bot?.name ?? "Deleted bot"} · {describePersonalRoutineTrigger(routine)}
        </Text>
        <Text style={styles.rowTertiary} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {routineTriggerStatusLabel(routine)}
        </Text>
      </View>
    </Pressable>
  );
}

function Check({ checked }: { readonly checked: boolean }) {
  return (
    <View style={[styles.check, checked ? styles.checkOn : null]}>
      {checked ? <View style={styles.checkDot} /> : null}
    </View>
  );
}

export function TasksScreen({
  native,
  onOpenTask,
  onOpenChat,
  onOpenRoutine,
  onNewRoutine,
}: {
  readonly native: NativePersonal;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
  readonly onOpenRoutine: (routineId: string) => void;
  readonly onNewRoutine: () => void;
}) {
  const environmentId = native.environmentId;
  const { tasks: taskFeed, error: taskError } = native.automation.usePersonalTasks(environmentId);
  const routinesQuery = native.automation.usePersonalRoutines(environmentId);
  const botsQuery = native.bots.usePersonalBotsList(environmentId);
  const history = native.client.useAtomCommand(native.automation.personalTaskHistory, {
    reportFailure: false,
  });
  const deleteMany = native.client.useAtomCommand(native.automation.personalRoutinesDeleteMany, {
    reportFailure: false,
  });
  const setEnabledMany = native.client.useAtomCommand(
    native.automation.personalRoutinesSetEnabledMany,
    { reportFailure: false },
  );
  const [view, setView] = useState<TaskListFilter>("work");
  const [older, setOlder] = useState<OlderTasks>(NO_OLDER_TASKS);
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const now = useMinuteNow();

  const routines = routinesQuery.data?.routines ?? [];
  const bots = botsQuery.data?.bots;
  const botMap = useMemo(() => botsById(bots), [bots]);
  const merged = useMemo(() => mergeTaskLists(taskFeed, older.tasks), [taskFeed, older.tasks]);
  const buckets = useMemo(() => taskBuckets(merged), [merged]);
  const counts = taskListCounts(buckets, routines);
  const loadState = tasksScreenState({
    view,
    tasks: merged,
    taskError,
    routinesLoaded: routinesQuery.data !== null,
    routinesError: routinesQuery.error,
  });

  const selecting = view === "scheduled" && selection !== null;
  const shownIds = useMemo(() => routines.map((routine) => routine.routineId), [routines]);
  const chosen = selection === null ? [] : visibleSelection(selection, shownIds);
  const everySelected =
    selection !== null && shownIds.length > 0 && shownIds.every((id) => selection.has(id));
  const { toPause, toResume } = routineBulkTargets(routines, chosen);

  const enterSelect = useCallback((first: string | null) => {
    setNotice(null);
    setSelection(new Set(first === null ? [] : [first]));
  }, []);
  const exitSelect = useCallback(() => setSelection(null), []);
  const toggle = useCallback((routineId: string) => {
    setSelection((current) => (current === null ? current : toggleSelection(current, routineId)));
  }, []);

  const loadOlder = async () => {
    if (older.loading) return;
    setOlder((current) => ({ ...current, loading: true, error: null }));
    const last = older.tasks.at(-1);
    const outcome = await history({
      environmentId,
      input: {
        limit: OLDER_PAGE_SIZE,
        ...(last === undefined ? {} : { before: last.taskId }),
      },
    });
    setOlder((current) =>
      outcome._tag === "Success"
        ? {
            tasks: [...current.tasks, ...outcome.value.tasks],
            hasMore: outcome.value.hasMore,
            loading: false,
            error: null,
          }
        : { ...current, loading: false, error: "Could not load older tasks." },
    );
  };

  const runBulk = async (action: "pause" | "resume" | "delete") => {
    const ids = action === "pause" ? toPause : action === "resume" ? toResume : chosen;
    if (ids.length === 0 || bulkBusy) return;
    if (action === "delete") {
      const confirmed = await confirmDestructive(
        bulkDeleteRoutinesConfirmMessage(ids.length),
        bulkDeleteConfirmLabel(ids.length, ROUTINE_NOUN),
      );
      if (!confirmed) return;
    }
    setBulkBusy(true);
    const done: Array<string> = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (let start = 0; start < ids.length; start += PERSONAL_ROUTINES_BATCH_MAX) {
      const chunk = ids
        .slice(start, start + PERSONAL_ROUTINES_BATCH_MAX)
        .map((id) => PersonalRoutineId.make(id));
      const outcome =
        action === "delete"
          ? await deleteMany({ environmentId, input: { routineIds: chunk } })
          : await setEnabledMany({
              environmentId,
              input: { routineIds: chunk, enabled: action === "resume" },
            });
      if (outcome._tag === "Success") {
        done.push(...outcome.value.done);
        failed.push(
          ...outcome.value.failed.map((entry) => ({
            id: entry.routineId,
            message: entry.message,
          })),
        );
      } else {
        failed.push(
          ...chunk.map((id) => ({ id, message: "Couldn't reach your laptop. Try again." })),
        );
      }
    }
    const verb = action === "delete" ? DELETE_VERB : action === "pause" ? PAUSE_VERB : RESUME_VERB;
    const summary = bulkResultNotice(
      verb,
      ROUTINE_NOUN,
      done.length,
      failed.map((entry) => entry.message),
    );
    setBulkBusy(false);
    setNotice(summary);
    setSelection(failed.length === 0 ? null : new Set(failed.map((entry) => entry.id)));
  };

  const list = view === "completed" ? buckets.completed : null;

  return (
    <View style={styles.screen}>
      {selecting ? (
        <View style={styles.header}>
          <Pressable
            onPress={exitSelect}
            accessibilityRole="button"
            style={styles.headerTextButton}
          >
            <Text style={styles.headerTextButtonLabel} maxFontSizeMultiplier={1.3}>
              Cancel
            </Text>
          </Pressable>
          <Text style={styles.selectCount} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {selectedCountLabel(chosen.length, ROUTINE_NOUN)}
          </Text>
          <Pressable
            onPress={() =>
              setSelection((current) =>
                current === null ? current : toggleAllSelection(current, shownIds),
              )
            }
            disabled={shownIds.length === 0}
            accessibilityRole="button"
            style={styles.headerTextButton}
          >
            <Text style={styles.headerTextButtonLabel} maxFontSizeMultiplier={1.3}>
              {everySelected ? "Deselect all" : "Select all"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            Tasks
          </Text>
          <View style={styles.headerActions}>
            {view === "scheduled" && routines.length > 0 ? (
              <Pressable
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Routine list options"
                style={styles.iconButton}
              >
                <IconDots size={24} color={tokens.text} strokeWidth={1.75} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={onNewRoutine}
              accessibilityRole="button"
              accessibilityLabel="New routine"
              style={styles.newButton}
            >
              <IconPlus size={22} color={tokens.primaryText} strokeWidth={2} />
            </Pressable>
          </View>
        </View>
      )}

      {selecting ? null : (
        <View style={styles.segments} accessibilityRole="tablist">
          {TASK_LIST_FILTERS.map((filter) => (
            <Segment
              key={filter.id}
              label={filter.label}
              count={counts[filter.id]}
              active={filter.id === view}
              attention={taskListCountNeedsAttention(filter.id)}
              onPress={() => {
                setView(filter.id);
                setSelection(null);
                setNotice(null);
              }}
            />
          ))}
        </View>
      )}

      {notice !== null ? (
        <Text
          style={[styles.notice, notice.failed ? styles.noticeFailed : null]}
          accessibilityRole="alert"
          maxFontSizeMultiplier={1.6}
        >
          {notice.text}
        </Text>
      ) : null}

      {view === "work" ? (
        <WorkScreen native={native} onOpenTask={onOpenTask} onOpenChat={onOpenChat} />
      ) : (
        <ScreenScroll contentStyle={selecting ? styles.scrollSelecting : undefined}>
          {loadState.kind === "error" ? (
            <EmptyText>{loadState.message}</EmptyText>
          ) : loadState.kind === "loading" ? (
            <EmptyText>Loading…</EmptyText>
          ) : view === "scheduled" ? (
            routines.length === 0 ? (
              <View style={styles.emptyBlock}>
                <EmptyText>{TASK_EMPTY_TEXT.scheduled}</EmptyText>
                <View style={styles.emptyButton}>
                  <TaskButton label="New routine" variant="primary" onPress={onNewRoutine} />
                </View>
              </View>
            ) : (
              routines.map((routine) => (
                <RoutineRow
                  key={routine.routineId}
                  routine={routine}
                  bot={botMap.get(routine.botId)}
                  selected={selection?.has(routine.routineId) ?? false}
                  selecting={selecting}
                  onPress={() =>
                    selecting ? toggle(routine.routineId) : onOpenRoutine(routine.routineId)
                  }
                  onLongPress={() => enterSelect(routine.routineId)}
                />
              ))
            )
          ) : list !== null && list.length === 0 ? (
            <EmptyText>{TASK_EMPTY_TEXT[view]}</EmptyText>
          ) : (
            <>
              {list?.map((task) => (
                <TaskRow
                  key={task.taskId}
                  task={task}
                  bot={botMap.get(task.botId)}
                  parentTitle={
                    task.parentTaskId === null
                      ? null
                      : (merged?.get(task.parentTaskId)?.title ?? null)
                  }
                  now={now}
                  onPress={() => onOpenTask(task.taskId)}
                />
              ))}
              {view === "completed" && older.hasMore ? (
                <View style={styles.olderBlock}>
                  <TaskButton
                    label={older.loading ? "Loading" : "Show older tasks"}
                    busy={older.loading}
                    onPress={() => void loadOlder()}
                  />
                  {older.error !== null ? (
                    <Text style={styles.noticeFailed} accessibilityRole="alert">
                      {older.error}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </ScreenScroll>
      )}

      {selecting ? (
        <View style={styles.actions}>
          <View style={styles.actionsLeft}>
            <TaskButton
              label="Pause"
              variant="secondary"
              grow={false}
              disabled={toPause.length === 0 || bulkBusy}
              onPress={() => void runBulk("pause")}
            />
            <TaskButton
              label="Resume"
              variant="secondary"
              grow={false}
              disabled={toResume.length === 0 || bulkBusy}
              onPress={() => void runBulk("resume")}
            />
          </View>
          <TaskButton
            label="Delete"
            variant="danger"
            grow={false}
            disabled={chosen.length === 0 || bulkBusy}
            busy={bulkBusy}
            onPress={() => void runBulk("delete")}
          />
        </View>
      ) : null}

      <SheetShell
        visible={menuOpen}
        title="Routine list options"
        onClose={() => setMenuOpen(false)}
      >
        <SheetAction
          label="Select routines"
          onPress={() => {
            setMenuOpen(false);
            enterSelect(null);
          }}
        />
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
  },
  title: { color: tokens.text, fontSize: 28, fontWeight: "700" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  newButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTextButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 2 },
  headerTextButtonLabel: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  selectCount: { color: tokens.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  segments: {
    flexDirection: "row",
    height: 44,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 8,
    backgroundColor: tokens.fillMuted,
    padding: 2,
  },
  segment: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderRadius: 6,
    paddingHorizontal: 2,
  },
  segmentActive: { backgroundColor: tokens.surface },
  segmentLabel: { color: tokens.textSecondary, fontSize: 12, flexShrink: 1 },
  segmentLabelActive: { color: tokens.text, fontWeight: "600" },
  countPill: {
    minWidth: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: tokens.surface,
    alignItems: "center",
  },
  countPillActive: { backgroundColor: tokens.fillMuted },
  countText: { color: tokens.textSecondary, fontSize: 11, fontWeight: "600" },
  countTextAttention: { color: tokens.text },
  notice: {
    color: tokens.textSecondary,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  noticeFailed: { color: tokens.error },
  scrollSelecting: { paddingBottom: 88 },
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  rowMetaLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowMeta: { color: tokens.textSecondary, fontSize: 13, flexShrink: 1 },
  rowTertiary: { color: tokens.textTertiary, fontSize: 13 },
  rowTime: { color: tokens.textTertiary, fontSize: 13, alignSelf: "flex-start", paddingTop: 2 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  checkDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.primaryText },
  emptyBlock: { paddingTop: 32, alignItems: "center" },
  emptyButton: { alignSelf: "stretch", paddingHorizontal: 16, marginTop: -8 },
  olderBlock: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  actions: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  actionsLeft: { flexDirection: "row", gap: 8 },
});
