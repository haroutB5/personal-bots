import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";

/**
 * The one place that says which sign-in sessions may receive a push: a session
 * is live when it is not revoked and has not expired. Browser subscriptions and
 * phone tokens both name their session, and every send, queue and listing goes
 * through this, so the two kinds of device cannot disagree.
 *
 * Match with `IN`, never `NOT IN` a dead list: a row whose session is missing
 * or null then fails closed (NULL never matches `IN`).
 */
export const liveSessionIds = (sql: SqlClient.SqlClient, nowIso: string): Statement.Fragment =>
  sql`(SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ${nowIso})`;

/**
 * How long a row whose session just expired survives the purge. A socket that
 * moves to a successor session rebinds its rows inside this window, so the
 * rebind never races the sweep. Sends keep the strict `liveSessionIds` test,
 * so an expired row is never sent to.
 */
export const EXPIRED_RECIPIENT_GRACE = Duration.seconds(60);

/**
 * Moves the browser subscriptions and phone tokens of `from` to `to`, only
 * when `to` is live. Idempotent: a second run finds nothing on `from`, and a
 * dead `to` moves nothing.
 */
export const followSessionSuccessor = (
  sql: SqlClient.SqlClient,
  from: string,
  to: string,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    const live = liveSessionIds(sql, DateTime.formatIso(yield* DateTime.now));
    yield* sql`
      UPDATE personal_push_subscriptions SET auth_session_id = ${to}
      WHERE auth_session_id = ${from} AND ${to} IN ${live}
    `;
    yield* sql`
      UPDATE personal_fcm_tokens SET auth_session_id = ${to}
      WHERE auth_session_id = ${from} AND ${to} IN ${live}
    `;
  });

/**
 * Deletes every browser subscription and phone token whose session is not
 * live (revoked, unknown or, for a browser from before the column existed,
 * none) or expired for longer than `EXPIRED_RECIPIENT_GRACE`, and the browser
 * notifications still waiting for those subscriptions. Idempotent. The sender runs it before it sends; revoke paths run it so
 * sign-out stops pushes at once.
 */
export const purgeDeadPushRecipients = (
  sql: SqlClient.SqlClient,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const live = liveSessionIds(
      sql,
      DateTime.formatIso(DateTime.subtractDuration(now, EXPIRED_RECIPIENT_GRACE)),
    );
    yield* sql`
      DELETE FROM personal_notification_outbox
      WHERE status = 'pending' AND subscription_id IN (
        SELECT subscription_id FROM personal_push_subscriptions
        WHERE auth_session_id IS NULL OR auth_session_id NOT IN ${live}
      )
    `;
    yield* sql`
      DELETE FROM personal_push_subscriptions
      WHERE auth_session_id IS NULL OR auth_session_id NOT IN ${live}
    `;
    yield* sql`DELETE FROM personal_fcm_tokens WHERE auth_session_id NOT IN ${live}`;
  });

/**
 * The same purge for a revoke path: a failure is logged and never blocks the
 * revoke itself, because the send query filters again and the sender purges
 * before it sends.
 */
export const purgeRevokedPushRecipients = (sql: SqlClient.SqlClient): Effect.Effect<void> =>
  purgeDeadPushRecipients(sql).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("push recipients could not be purged after a revoke"),
    ),
  );
