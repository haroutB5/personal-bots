import * as Stream from "effect/Stream";

/**
 * Marks a subscription feed as loaded before its first event.
 *
 * A feed folds its replay with `Stream.scan`, and `scan` emits nothing when its
 * upstream emits nothing. On a root with no data the replay was therefore empty
 * and the feed never produced a first value at all, so a consumer that reads
 * `null` as "still loading" (the Tasks page) sat on "Loading…" forever instead
 * of showing its empty state. Putting the fold's empty state in front means an
 * empty feed reads as loaded-and-empty straight away, while a feed with data
 * still replaces it with the real value as soon as the replay lands (the tasks
 * and groups feeds group it into 50 ms chunks, so the worst case is one frame
 * of the empty state on a slow connection).
 */
export function feedStartsWith<A>(initial: A) {
  return <E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.prepend([initial]));
}
