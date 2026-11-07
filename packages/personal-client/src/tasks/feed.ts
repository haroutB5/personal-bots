import type { PersonalTask } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

/** The empty fold, and so the feed's first value. */
export const EMPTY_TASKS_FEED: ReadonlyMap<string, PersonalTask> = new Map();

/**
 * Marks a subscription feed as loaded before its first event.
 *
 * A feed folds with `Stream.scan`, which emits nothing when its upstream emits
 * nothing. Without the empty value in front, a root with no data never produces
 * a first value and every consumer reads "still loading" forever.
 */
export function feedStartsWith<A>(initial: A) {
  return <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.prepend([initial]));
}

/**
 * Unfinished tasks and the newest finished ones, kept current by
 * `personalTasks.subscribe` (replay as upserts, then live upserts). Emits the
 * whole map each time. Entries are summaries (`detailOmitted`), so full text
 * comes from `personalTasks.get`.
 */
export function foldPersonalTasksFeed<E, R>(
  stream: Stream.Stream<{ readonly task: PersonalTask }, E, R>,
): Stream.Stream<ReadonlyMap<string, PersonalTask>, E, R> {
  return feedStartsWith(EMPTY_TASKS_FEED)(
    stream.pipe(
      // The replay arrives as one event per task, so chunking keeps one copy
      // per batch while live upserts still land within 50 ms.
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
