import * as Effect from "effect/Effect";

/**
 * One durable multi-step write, run without interruption between its steps.
 *
 * Before 1.66.70 every SQLite statement ran synchronously on the caller's
 * thread, so an operation that wrote in two steps could not be stopped between
 * them. The serialized worker makes each statement an interruption point, so a
 * browser that disconnects mid-request (or any RPC interrupt) stopped the
 * operation after the first write. QA's 1.66.70 blocker was exactly that: a
 * chat's projection row landed, the bot link after it did not, and the chat
 * vanished from its bot's list (`qa/hbots-16670-qa/SUMMARY.md`).
 *
 * The region is short by construction (a handful of statements, plus the
 * engine dispatch a sequence already awaited). A retried operation still
 * dedupes on its deterministic command ids, so repeating it is safe.
 */
export const uninterruptibleWrite = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.uninterruptible(effect);
