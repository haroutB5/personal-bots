import { PERSONAL_TASK_TERMINAL_STATUSES, type PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One handoff that is running now, for the "Working now" card. */
export interface WorkingNowItem {
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
  readonly title: string;
  /** The receiving bot's task chat, when the task has one yet. */
  readonly threadId: string | null;
  readonly sinceMs: number;
}

/** Running handoffs between bots that are on the screen, oldest first. */
export function deriveWorkingNow(
  tasks: ReadonlyArray<PersonalTask>,
  botIds: ReadonlySet<string>,
): WorkingNowItem[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId as string, task] as const));
  const items: WorkingNowItem[] = [];
  for (const child of tasks) {
    if (child.parentTaskId === null) continue;
    if (PERSONAL_TASK_TERMINAL_STATUSES.includes(child.status)) continue;
    const parent = tasksById.get(child.parentTaskId as string);
    if (parent === undefined) continue;
    const from = parent.botId as string;
    const to = child.botId as string;
    if (from === to || !botIds.has(from) || !botIds.has(to)) continue;
    items.push({
      taskId: child.taskId as string,
      from,
      to,
      title: child.title,
      threadId: child.threadId === null ? null : (child.threadId as string),
      sinceMs: DateTime.toEpochMillis(child.startedAt ?? child.createdAt),
    });
  }
  return items.toSorted((left, right) => left.sinceMs - right.sinceMs);
}

/** "5 min", "1 h", "1 h 9 min": how long a handoff has been running. */
export function formatWorkingFor(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}
