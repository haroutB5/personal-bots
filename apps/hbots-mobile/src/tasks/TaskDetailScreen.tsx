import {
  canCancelTask,
  canRetryTask,
  formatLocalDateTime,
  mergeTaskLists,
  stopTaskConfirmMessage,
  taskStatusLabel,
  taskStatusTone,
  workRecordIsEmpty,
} from "@hbots/personal-client/conversation/taskPresentation";
import {
  PersonalTaskId,
  type PersonalBot,
  type PersonalTask,
  type PersonalTaskWorkRecord,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { confirmDestructive } from "../components/confirmDestructive";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { taskResultHeading } from "./tasksModel";
import {
  Card,
  DetailRow,
  EmptyText,
  ScreenScroll,
  SectionLabel,
  SmallBotAvatar,
  StatusDot,
  TaskButton,
} from "./TaskUi";

function WorkRecordCard({ record }: { readonly record: PersonalTaskWorkRecord }) {
  const [open, setOpen] = useState(false);
  if (workRecordIsEmpty(record)) return null;
  return (
    <Pressable
      onPress={() => setOpen((value) => !value)}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel="Work record"
      style={styles.workRecord}
    >
      <View style={styles.workRecordHead}>
        <Text style={styles.workRecordTitle} maxFontSizeMultiplier={1.6}>
          Work record
        </Text>
        <Text style={styles.workRecordToggle} maxFontSizeMultiplier={1.3}>
          {open ? "Hide" : "Show"}
        </Text>
      </View>
      {open ? (
        <View style={styles.workRecordBody}>
          {record.nextStep.length > 0 ? (
            <View>
              <SectionLabel>Next step</SectionLabel>
              <Text style={styles.bodyText} maxFontSizeMultiplier={1.6}>
                {record.nextStep}
              </Text>
            </View>
          ) : null}
          {record.outstanding.length > 0 ? (
            <View>
              <SectionLabel>Left to do</SectionLabel>
              {record.outstanding.map((item) => (
                <Text key={item} style={styles.bodyText} maxFontSizeMultiplier={1.6}>
                  · {item}
                </Text>
              ))}
            </View>
          ) : null}
          {record.decisions.length > 0 ? (
            <View>
              <SectionLabel>Decisions</SectionLabel>
              {record.decisions.map((item) => (
                <Text key={item} style={styles.bodyText} maxFontSizeMultiplier={1.6}>
                  · {item}
                </Text>
              ))}
            </View>
          ) : null}
          {record.evidence.length > 0 ? (
            <View>
              <SectionLabel>Evidence</SectionLabel>
              {record.evidence.map((item) => (
                <Text
                  key={`${item.label}:${item.ref}`}
                  style={styles.bodyText}
                  maxFontSizeMultiplier={1.6}
                >
                  · {item.label}: {item.ref}
                </Text>
              ))}
            </View>
          ) : null}
          {record.lastResult.length > 0 ? (
            <View>
              <SectionLabel>
                Last result{record.lastStatus === null ? "" : ` (${record.lastStatus})`}
              </SectionLabel>
              <Text style={styles.bodyText} maxFontSizeMultiplier={1.6}>
                {record.lastResult}
              </Text>
            </View>
          ) : null}
          {record.updates.length > 0 ? (
            <View>
              <SectionLabel>Updates it was sent</SectionLabel>
              {record.updates.map((update) => (
                <Text
                  key={`${update.at}-${update.text}`}
                  style={styles.bodyText}
                  maxFontSizeMultiplier={1.6}
                >
                  · {update.text}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function RelatedTask({
  task,
  bot,
  onPress,
}: {
  readonly task: PersonalTask;
  readonly bot: PersonalBot | undefined;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${bot?.name ?? "Deleted bot"}, ${taskStatusLabel(task.status)}`}
      android_ripple={{ color: "rgba(255,255,255,0.08)" }}
      style={styles.relatedRow}
    >
      <SmallBotAvatar bot={bot} size={28} />
      <View style={styles.relatedText}>
        <Text style={styles.relatedTitle} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {task.title}
        </Text>
        <View style={styles.relatedMetaLine}>
          <StatusDot tone={taskStatusTone(task.status)} />
          <Text style={styles.relatedMeta} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {bot?.name ?? "Deleted bot"} · {taskStatusLabel(task.status)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function when(value: DateTime.Utc | null): string {
  return value === null ? "" : formatLocalDateTime(DateTime.toEpochMillis(value));
}

export function TaskDetailScreen({
  native,
  taskId,
  onBack,
  onOpenTask,
  onOpenChat,
}: {
  readonly native: NativePersonal;
  readonly taskId: string;
  readonly onBack: () => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenChat: (botId: string, threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId;
  const id = useMemo(() => PersonalTaskId.make(taskId), [taskId]);
  const { tasks: feed } = native.automation.usePersonalTasks(environmentId);
  const detail = native.automation.usePersonalTaskDetail(environmentId, id);
  const parentTaskId = (feed?.get(taskId) ?? detail.data?.task)?.parentTaskId ?? null;
  const related = native.automation.usePersonalRelatedTasks(environmentId, {
    taskIds: parentTaskId === null ? [id] : [id, parentTaskId],
  });
  const tasks = useMemo(() => mergeTaskLists(feed, related), [feed, related]);
  const botsQuery = native.bots.usePersonalBotsList(environmentId);
  const cancel = native.client.useAtomCommand(native.automation.personalTaskCancel);
  const retry = native.client.useAtomCommand(native.automation.personalTaskRetry);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const botById = useMemo(
    () => new Map<string, PersonalBot>((botsQuery.data?.bots ?? []).map((bot) => [bot.botId, bot])),
    [botsQuery.data],
  );
  const task = tasks?.get(taskId) ?? detail.data?.task;
  const fullTask = detail.data?.task;
  const result =
    task === undefined
      ? null
      : fullTask !== undefined &&
          fullTask.taskId === task.taskId &&
          DateTime.toEpochMillis(fullTask.updatedAt) >= DateTime.toEpochMillis(task.updatedAt)
        ? fullTask.result
        : task.result;
  const updatedAt = task === undefined ? null : DateTime.toEpochMillis(task.updatedAt);
  const refreshDetail = detail.refresh;
  useEffect(() => {
    if (updatedAt !== null) refreshDetail();
  }, [updatedAt, refreshDetail]);

  const parent =
    task?.parentTaskId === null || task?.parentTaskId === undefined
      ? undefined
      : tasks?.get(task.parentTaskId);

  const children = useMemo(
    () =>
      [...(tasks?.values() ?? [])]
        .filter((entry) => entry.parentTaskId === taskId)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        ),
    [tasks, taskId],
  );

  const run = useCallback(
    async (action: "cancel" | "retry") => {
      if (task === undefined) return;
      if (action === "cancel") {
        const confirmed = await confirmDestructive(stopTaskConfirmMessage(task.title), "Stop task");
        if (!confirmed) return;
      }
      setBusy(true);
      setActionError(null);
      const outcome = await (action === "cancel" ? cancel : retry)({
        environmentId,
        input: { taskId: task.taskId },
      });
      setBusy(false);
      if (outcome._tag !== "Success") {
        setActionError(action === "cancel" ? "Could not stop the task." : "Could not retry.");
      }
    },
    [cancel, environmentId, retry, task],
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title="Task" onBack={onBack} />
      {task === undefined ? (
        <EmptyText>
          {tasks === null || detail.isPending ? "Loading…" : "This task was not found."}
        </EmptyText>
      ) : (
        <ScreenScroll>
          <View style={styles.body}>
            <Card>
              <View style={styles.botLine}>
                <SmallBotAvatar bot={botById.get(task.botId)} />
                <Text style={styles.botName} maxFontSizeMultiplier={1.6}>
                  {botById.get(task.botId)?.name ?? "Deleted bot"}
                </Text>
              </View>
              <Text style={styles.taskTitle} maxFontSizeMultiplier={1.6}>
                {task.title}
              </Text>
              <View style={styles.statusLine}>
                <StatusDot tone={taskStatusTone(task.status)} />
                <Text style={styles.statusText} maxFontSizeMultiplier={1.6}>
                  {taskStatusLabel(task.status)}
                  {task.source === "routine" ? " · from a routine" : ""}
                </Text>
              </View>
              <View style={styles.divider}>
                <DetailRow label="Created">{when(task.createdAt)}</DetailRow>
                {task.startedAt !== null ? (
                  <DetailRow label="Started">{when(task.startedAt)}</DetailRow>
                ) : null}
                {task.completedAt !== null ? (
                  <DetailRow label="Finished">{when(task.completedAt)}</DetailRow>
                ) : null}
                {task.availableAt !== null && task.status === "rate_limited" ? (
                  <DetailRow label="Retries at">{when(task.availableAt)}</DetailRow>
                ) : null}
                {detail.data !== null && detail.data.attempts.length > 0 ? (
                  <DetailRow label="Attempts">{String(detail.data.attempts.length)}</DetailRow>
                ) : null}
              </View>
            </Card>

            {task.errorMessage !== null && task.status !== "completed" ? (
              <View style={styles.errorCard}>
                <Text style={styles.cardTitle} maxFontSizeMultiplier={1.6}>
                  What went wrong
                </Text>
                <Text style={styles.bodyText} maxFontSizeMultiplier={1.6}>
                  {task.errorMessage}
                </Text>
              </View>
            ) : null}

            {result !== null && result.summary.trim().length > 0 ? (
              <Card>
                <Text style={styles.cardTitle} maxFontSizeMultiplier={1.6}>
                  {taskResultHeading(task)}
                </Text>
                <Text style={styles.resultText} maxFontSizeMultiplier={1.6}>
                  {result.summary}
                </Text>
              </Card>
            ) : null}

            {detail.data?.workRecord != null ? (
              <WorkRecordCard record={detail.data.workRecord} />
            ) : null}

            {parent !== undefined ? (
              <View>
                <SectionLabel>Delegated by</SectionLabel>
                <RelatedTask
                  task={parent}
                  bot={botById.get(parent.botId)}
                  onPress={() => onOpenTask(parent.taskId)}
                />
              </View>
            ) : null}

            {children.length > 0 ? (
              <View>
                <SectionLabel>Delegated work</SectionLabel>
                {children.map((child) => (
                  <RelatedTask
                    key={child.taskId}
                    task={child}
                    bot={botById.get(child.botId)}
                    onPress={() => onOpenTask(child.taskId)}
                  />
                ))}
              </View>
            ) : null}

            <View style={styles.buttons}>
              {canCancelTask(task.status) ? (
                <TaskButton
                  label="Stop task"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void run("cancel")}
                />
              ) : null}
              {canRetryTask(task.status) ? (
                <TaskButton
                  label="Retry"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void run("retry")}
                />
              ) : null}
              {task.threadId !== null ? (
                <TaskButton
                  label="Open chat"
                  variant="primary"
                  onPress={() => onOpenChat(task.botId, task.threadId ?? "")}
                />
              ) : null}
            </View>
            {actionError !== null ? (
              <Text style={styles.actionError} accessibilityRole="alert">
                {actionError}
              </Text>
            ) : null}
          </View>
        </ScreenScroll>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { paddingHorizontal: 16, gap: 16 },
  botLine: { flexDirection: "row", alignItems: "center", gap: 12 },
  botName: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  taskTitle: { color: tokens.text, fontSize: 17, fontWeight: "600", marginTop: 12 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  statusText: { color: tokens.textSecondary, fontSize: 14 },
  divider: {
    marginTop: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  cardTitle: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  bodyText: { color: tokens.text, fontSize: 14, lineHeight: 21, marginTop: 4 },
  resultText: { color: tokens.text, fontSize: 15, lineHeight: 22, marginTop: 4 },
  errorCard: {
    backgroundColor: tokens.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
    borderRadius: 16,
    padding: 16,
  },
  workRecord: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  workRecordHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  workRecordTitle: { color: tokens.text, fontSize: 14, fontWeight: "600" },
  workRecordToggle: { color: tokens.textSecondary, fontSize: 13 },
  workRecordBody: { gap: 12, marginTop: 12 },
  relatedRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
  },
  relatedText: { flex: 1, minWidth: 0 },
  relatedTitle: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  relatedMetaLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  relatedMeta: { color: tokens.textSecondary, fontSize: 13 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionError: { color: tokens.error, fontSize: 14 },
});
