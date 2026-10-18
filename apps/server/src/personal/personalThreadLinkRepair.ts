import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A chat create that was interrupted between its two durable writes.
 *
 * `PersonalBotService.createThread` writes a `personal_meta` intent row before
 * dispatching `thread.create`, and clears it once the bot link exists. The
 * write sequence itself is uninterruptible, so a client disconnect cannot stop
 * it halfway; the intent covers the remaining window, a process that dies
 * between the dispatch and the link (or between the link and the cleanup).
 *
 * At boot, every intent is resolved against the durable state:
 * - projection present, bot present, no link -> insert the link (the chat is
 *   listed again with the bot it was made for);
 * - otherwise (no projection, a deleted projection, or a deleted bot) -> drop
 *   the intent: there is nothing to link.
 *
 * Idempotent and additive: no schema change, and a second boot has nothing to
 * do. The worker and the inline path both go through it.
 */
export const PERSONAL_THREAD_LINK_INTENT_PREFIX = "personalThreadLinkIntent:";

export const personalThreadLinkIntentKey = (threadId: string): string =>
  `${PERSONAL_THREAD_LINK_INTENT_PREFIX}${threadId}`;

const intentLike = `${PERSONAL_THREAD_LINK_INTENT_PREFIX}%`;
/** `substr` is 1-based, so the thread id starts one past the prefix. */
const THREAD_ID_OFFSET = PERSONAL_THREAD_LINK_INTENT_PREFIX.length + 1;

export const repairPersonalThreadLinks = Effect.fn("repairPersonalThreadLinks")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    const intents = yield* sql<{ readonly key: string }>`
        SELECT key AS "key"
        FROM personal_meta
        WHERE key LIKE ${intentLike}
      `;
    if (intents.length === 0) return { linked: 0, dropped: 0 };

    const linked = yield* sql<{ readonly threadId: string }>`
        INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
        SELECT
          substr(m.key, ${THREAD_ID_OFFSET}) AS thread_id,
          m.value AS bot_id,
          t.created_at AS created_at
        FROM personal_meta m
        JOIN projection_threads t
          ON t.thread_id = substr(m.key, ${THREAD_ID_OFFSET})
        JOIN personal_bots b
          ON b.bot_id = m.value AND b.deleted_at IS NULL
        WHERE m.key LIKE ${intentLike}
          AND t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM personal_bot_threads l
            WHERE l.thread_id = t.thread_id
          )
        RETURNING thread_id AS "threadId"
      `;

    // A link now exists, or no live projection/bot can ever accept one.
    yield* sql`
        DELETE FROM personal_meta
        WHERE key LIKE ${intentLike}
          AND (
            EXISTS (
              SELECT 1 FROM personal_bot_threads l
              WHERE l.thread_id = substr(personal_meta.key, ${THREAD_ID_OFFSET})
            )
            OR NOT EXISTS (
              SELECT 1 FROM projection_threads t
              WHERE t.thread_id = substr(personal_meta.key, ${THREAD_ID_OFFSET})
                AND t.deleted_at IS NULL
            )
            OR NOT EXISTS (
              SELECT 1 FROM personal_bots b
              WHERE b.bot_id = personal_meta.value AND b.deleted_at IS NULL
            )
          )
      `;

    const remaining = yield* sql<{ readonly key: string }>`
        SELECT key AS "key"
        FROM personal_meta
        WHERE key LIKE ${intentLike}
      `;
    return {
      linked: linked.length,
      dropped: intents.length - remaining.length,
    };
  }).pipe(sql.withTransaction);
});

/** For the startup fork: logs anything unexpected instead of failing the boot. */
export const repairPersonalThreadLinksSafely = repairPersonalThreadLinks().pipe(
  Effect.tap((summary) =>
    summary.linked === 0 && summary.dropped === 0
      ? Effect.void
      : Effect.logInfo("repaired interrupted personal chat creations", summary),
  ),
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning("repairing interrupted personal chat creations failed", {
          cause: Cause.pretty(cause),
        }),
  ),
  Effect.asVoid,
);
