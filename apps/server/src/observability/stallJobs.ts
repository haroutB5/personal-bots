import { beginStallJob } from "@t3tools/shared/stallContext";
import * as Effect from "effect/Effect";

/**
 * Marks `effect` as a named job for the stall recorder: while it runs it is listed
 * as running, and a long one is remembered after it ends, so a stall report can say
 * which periodic job or handler was active. `name` is a static label, never an id
 * or text. Costs two clock reads and a map update per run, and nothing when
 * `T3CODE_STALL_RECORDER=off`.
 */
export const withStallJob =
  (name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => beginStallJob(name)),
      () => effect,
      (end) => Effect.sync(end),
    );
