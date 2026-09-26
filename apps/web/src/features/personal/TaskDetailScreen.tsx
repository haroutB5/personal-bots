import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type { PersonalBot, PersonalTask, PersonalTaskId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { ChevronLeft } from "lucide-react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { shouldPreserveAssistantLineBreaks } from "~/components/chat/MessagesTimeline.logic";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  canCancelTask,
  canRetryTask,
  formatLocalDateTime,
  mergeTaskLists,
  stopTaskConfirmMessage,
  taskStatusLabel,
  taskStatusTone,
} from "./taskPresentation";
import { SmallBotAvatar, StatusDot } from "./TasksScreen";
import {
  personalTaskCancel,
  personalTaskRetry,
  usePersonalRelatedTasks,
  usePersonalTaskDetail,
  usePersonalTasks,
} from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import { useCloseTaskNotifications } from "./staleNotifications";

export const DETAIL_CARD =
  "rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4";
export const PRIMARY_BUTTON =
  "flex h-11 flex-1 items-center justify-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-40";
export const SECONDARY_BUTTON =
  "flex h-11 flex-1 items-center justify-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[14px]">
      <dt className="shrink-0 text-[var(--personal-text-secondary)]">{label}</dt>
      <dd className="min-w-0 text-right text-[var(--personal-text)]">{children}</dd>
    </div>
  );
}

const when = (value: DateTime.Utc | null) =>
  value === null ? null : formatLocalDateTime(DateTime.toEpochMillis(value));

function RelatedTask({ task, bot }: { task: PersonalTask; bot: PersonalBot | undefined }) {
  return (
    <Link
      to="/tasks/$taskId"
      params={{ taskId: task.taskId }}
      className="flex min-h-12 items-center gap-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
    >
      <SmallBotAvatar bot={bot} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium text-[var(--personal-text)]">
          {task.title}
        </span>
        <span className="flex items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
          <StatusDot tone={taskStatusTone(task.status)} />
          {bot?.name ?? "Deleted bot"} · {taskStatusLabel(task.status)}
        </span>
      </span>
    </Link>
  );
}

/** /tasks/$taskId: live status, timestamps, delegation tree, result and actions. */
export function TaskDetailScreen({ taskId }: { taskId: PersonalTaskId }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  // The task is on screen: its "finished" notification is read.
  useCloseTaskNotifications(taskId);
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const detail = usePersonalTaskDetail(environmentId, taskId);
  // The feed only carries recent finished tasks: fetch this task, its parent
  // and its children as summaries too, so an old task shows its whole tree.
  const parentTaskId = (taskFeed?.get(taskId) ?? detail.data?.task)?.parentTaskId ?? null;
  const relatedTasks = usePersonalRelatedTasks(environmentId, {
    taskIds: parentTaskId === null ? [taskId] : [taskId, parentTaskId],
  });
  const tasks = useMemo(() => mergeTaskLists(taskFeed, relatedTasks), [taskFeed, relatedTasks]);
  const botsQuery = usePersonalBotsList(environmentId);
  const cancel = useAtomCommand(personalTaskCancel);
  const retry = useAtomCommand(personalTaskRetry);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const botById = useMemo(
    () => new Map<string, PersonalBot>((botsQuery.data?.bots ?? []).map((bot) => [bot.botId, bot])),
    [botsQuery.data],
  );
  const task = tasks?.get(taskId) ?? detail.data?.task;
  // Lists carry a result preview; the full result is the detail's, unless the
  // live task has moved on since the detail was read (it refetches below).
  const fullTask = detail.data?.task;
  const result =
    task === undefined
      ? null
      : fullTask !== undefined &&
          fullTask.taskId === task.taskId &&
          DateTime.toEpochMillis(fullTask.updatedAt) >= DateTime.toEpochMillis(task.updatedAt)
        ? fullTask.result
        : task.result;
  const updatedAt = task === undefined ? null : DateTime.formatIso(task.updatedAt);
  const refreshDetail = detail.refresh;
  // Attempts come from personalTasks.get; refetch whenever the live task moves.
  useEffect(() => {
    if (updatedAt !== null) refreshDetail();
  }, [updatedAt, refreshDetail]);

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

  const header = (
    <header className="flex h-14 items-center gap-1">
      <Link
        to="/tasks"
        aria-label="Back to Tasks"
        className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
      </Link>
      <h1 className="text-[19px] font-bold text-[var(--personal-text)]">Task</h1>
    </header>
  );

  if (task === undefined || environmentId === null) {
    return (
      <div className="px-5">
        {header}
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          {tasks === null || detail.isPending ? "Loading…" : "This task was not found."}
        </p>
      </div>
    );
  }

  const bot = botById.get(task.botId);
  const parent = task.parentTaskId === null ? undefined : tasks?.get(task.parentTaskId);
  const run = async (action: "cancel" | "retry") => {
    if (action === "cancel") {
      const message = stopTaskConfirmMessage(task.title);
      const confirmed =
        (await requestConfirmDialog(message, {
          variant: "destructive",
          confirmLabel: "Stop task",
        })) ?? window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    setActionError(null);
    const result = await (action === "cancel" ? cancel : retry)({
      environmentId,
      input: { taskId: task.taskId },
    });
    setBusy(false);
    setActionError(
      commandFailureMessage(
        result,
        action === "cancel" ? "Could not stop the task." : "Could not retry.",
      ),
    );
  };

  return (
    <div className="flex flex-col gap-4 px-5 pb-8">
      {header}

      <section className={DETAIL_CARD}>
        <div className="flex items-center gap-3">
          <SmallBotAvatar bot={bot} />
          <span className="text-[15px] font-semibold text-[var(--personal-text)]">
            {bot?.name ?? "Deleted bot"}
          </span>
        </div>
        <h2 className="mt-3 text-[17px] font-semibold text-[var(--personal-text)]">{task.title}</h2>
        <p className="mt-1 flex items-center gap-1.5 text-[14px] text-[var(--personal-text-secondary)]">
          <StatusDot tone={taskStatusTone(task.status)} />
          {taskStatusLabel(task.status)}
          {task.source === "routine" ? " · from a routine" : null}
        </p>
        <dl className="mt-3 border-t border-[var(--personal-border)] pt-2">
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
            <DetailRow label="Attempts">{detail.data.attempts.length}</DetailRow>
          ) : null}
        </dl>
      </section>

      {task.errorMessage !== null && task.status !== "completed" ? (
        <section className="rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] p-4">
          <h3 className="text-[14px] font-semibold text-[var(--personal-text)]">What went wrong</h3>
          <p className="mt-1 text-[14px] break-words whitespace-pre-wrap text-[var(--personal-text)]">
            {task.errorMessage}
          </p>
        </section>
      ) : null}

      {result !== null && result.summary.trim().length > 0 ? (
        <section className={DETAIL_CARD}>
          <h3 className="text-[14px] font-semibold text-[var(--personal-text)]">Result</h3>
          {/* A bot writes its result in markdown, the same as a reply: shown
              as plain text it read "**Cause**" and `code` with the marks in. */}
          <div className="personal-markdown mt-1 text-[15px] leading-[1.5] break-words text-[var(--personal-text)] md:text-[16px] md:leading-[1.6]">
            <ChatMarkdown
              text={result.summary}
              cwd={undefined}
              lineBreaks={shouldPreserveAssistantLineBreaks(result.summary)}
            />
          </div>
        </section>
      ) : null}

      {parent !== undefined ? (
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-[var(--personal-section-label)] uppercase">
            Delegated by
          </h3>
          <RelatedTask task={parent} bot={botById.get(parent.botId)} />
        </section>
      ) : null}

      {children.length > 0 ? (
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-[var(--personal-section-label)] uppercase">
            Delegated work
          </h3>
          <div className="divide-y divide-[var(--personal-border)]">
            {children.map((child) => (
              <RelatedTask key={child.taskId} task={child} bot={botById.get(child.botId)} />
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2.5">
        {canCancelTask(task.status) ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => void run("cancel")}
          >
            Stop task
          </button>
        ) : null}
        {canRetryTask(task.status) ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => void run("retry")}
          >
            Retry
          </button>
        ) : null}
        {task.threadId !== null ? (
          <Link
            to="/bots/$botId/$threadId"
            params={{ botId: task.botId, threadId: task.threadId }}
            className={PRIMARY_BUTTON}
          >
            Open chat
          </Link>
        ) : null}
      </div>
      {actionError !== null ? (
        <p role="alert" className="text-[14px] text-[var(--personal-error)]">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
