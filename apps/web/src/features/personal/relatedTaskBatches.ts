import type { PersonalTask, PersonalTaskId } from "@t3tools/contracts";

/** The server answers at most this many `taskIds` per related request (its TASK_RELATED_MAX_IDS). */
export const RELATED_TASK_IDS_PER_REQUEST = 100;

/**
 * Tasks for any number of ids, asked for in batches the server answers in
 * full, merged in batch order. Null until the first batch has answered; later
 * batches join as they land.
 */
export function relatedTasksInBatches(
  taskIds: ReadonlyArray<PersonalTaskId>,
  fetchBatch: (batch: ReadonlyArray<PersonalTaskId>) => ReadonlyArray<PersonalTask> | null,
): ReadonlyArray<PersonalTask> | null {
  let tasks: PersonalTask[] | null = null;
  for (let start = 0; start < taskIds.length; start += RELATED_TASK_IDS_PER_REQUEST) {
    const batch = fetchBatch(taskIds.slice(start, start + RELATED_TASK_IDS_PER_REQUEST));
    if (batch !== null) (tasks ??= []).push(...batch);
  }
  return tasks;
}
