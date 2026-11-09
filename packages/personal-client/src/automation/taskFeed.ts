import type { PersonalTask, PersonalTaskId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

/**
 * Marks a subscription feed as loaded before its first event.
 * A feed folds its replay with `Stream.scan`, and `scan` emits nothing when its
 * upstream emits nothing. On a root with no data the replay is therefore empty
 */
export function feedStartsWith<A>(initial: A) {
  return <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.prepend([initial]));
}

/** The empty fold, and so the task feed's first value. */
export const EMPTY_TASKS_FEED: ReadonlyMap<string, PersonalTask> = new Map();

/**
 * Unfinished tasks and the newest finished ones, kept current by
 * `personalTasks.subscribe` (replay as upserts, then live upserts). Emits the
 * whole map each time. Entries are summaries (`detailOmitted`): no objective
 * and only a result preview.
 */
export function foldPersonalTasksFeed<E, R>(
  stream: Stream.Stream<{ readonly task: PersonalTask }, E, R>,
): Stream.Stream<ReadonlyMap<string, PersonalTask>, E, R> {
  return feedStartsWith(EMPTY_TASKS_FEED)(
    stream.pipe(
      // The replay arrives as one event per task; folding it per event would
      // copy the map n times (O(n^2)). Chunks bound that to one copy per batch
      // while live upserts still land within 50 ms.
      Stream.groupedWithin(256, "50 millis"),
      Stream.scan(
        () => EMPTY_TASKS_FEED,
        (tasks, events) => {
          const next = new Map(tasks);
          for (const event of events) next.set(event.task.taskId, event.task);
          return next;
        },
      ),
    ),
  );
}

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
