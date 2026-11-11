import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { PhonePushKind } from "@t3tools/contracts";

export const PHONE_NOTIFICATION_RETENTION_DAYS = 7;

export interface FcmTokenRow {
  readonly token: string;
  readonly authSessionId: string;
  readonly subject: string;
}

export interface PhoneNotificationRow {
  readonly notificationId: string;
  readonly subject: string;
  readonly kind: PhonePushKind;
  readonly botId: string;
  readonly threadId: string;
  readonly requestId: string | null;
  readonly body: string | null;
}

export interface PhoneNotificationInput {
  readonly notificationId: string;
  readonly kind: PhonePushKind;
  readonly botId: string;
  readonly threadId: string;
  readonly requestId: string | null;
  /** The notification text as the web push carries it; null when the bot hides previews. */
  readonly body: string | null;
}

export type FcmTokenStore = ReturnType<typeof makeFcmTokenStore>;

export const makeFcmTokenStore = (sql: SqlClient.SqlClient) => {
  const subjectOfSession = (sessionId: string) =>
    sql<{ readonly subject: string }>`
      SELECT subject AS "subject" FROM auth_sessions
      WHERE session_id = ${sessionId} AND revoked_at IS NULL
      LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.subject)));

  const register = (input: {
    readonly token: string;
    readonly appVersion: string;
    readonly sessionId: string;
    readonly subject: string;
  }) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_fcm_tokens (
          token, auth_session_id, subject, app_version, created_at, last_seen_at, last_error
        )
        VALUES (
          ${input.token}, ${input.sessionId}, ${input.subject}, ${input.appVersion},
          ${nowIso}, ${nowIso}, NULL
        )
        ON CONFLICT (token) DO UPDATE SET
          auth_session_id = excluded.auth_session_id,
          subject = excluded.subject,
          app_version = excluded.app_version,
          last_seen_at = excluded.last_seen_at,
          last_error = NULL
      `;
    });

  const removeForSubject = (token: string, subject: string) =>
    sql`DELETE FROM personal_fcm_tokens WHERE token = ${token} AND subject = ${subject}`.pipe(
      Effect.asVoid,
    );

  const removeToken = (token: string) =>
    sql`DELETE FROM personal_fcm_tokens WHERE token = ${token}`.pipe(Effect.asVoid);

  const markError = (token: string, reason: string) =>
    sql`UPDATE personal_fcm_tokens SET last_error = ${reason} WHERE token = ${token}`.pipe(
      Effect.asVoid,
    );

  const markSent = (token: string) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE personal_fcm_tokens SET last_error = NULL, last_seen_at = ${nowIso}
        WHERE token = ${token}
      `;
    });

  const list = sql<FcmTokenRow>`
    SELECT token AS "token", auth_session_id AS "authSessionId", subject AS "subject"
    FROM personal_fcm_tokens ORDER BY created_at ASC
  `;

  const purgeRevoked = sql`
    DELETE FROM personal_fcm_tokens
    WHERE auth_session_id IN (SELECT session_id FROM auth_sessions WHERE revoked_at IS NOT NULL)
  `.pipe(Effect.asVoid);

  const recordNotification = (input: PhoneNotificationInput, subjects: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* Effect.forEach(
        subjects,
        (subject) =>
          sql<{ readonly subject: string }>`
          INSERT INTO personal_phone_notifications (
            notification_id, subject, kind, bot_id, thread_id, request_id, body, created_at
          )
          VALUES (
            ${input.notificationId}, ${subject}, ${input.kind}, ${input.botId},
            ${input.threadId}, ${input.requestId}, ${input.body}, ${nowIso}
          )
          ON CONFLICT (notification_id, subject) DO NOTHING
          RETURNING subject AS "subject"
        `,
      );
      return new Set(inserted.flat().map((row) => row.subject));
    });

  const findNotification = (notificationId: string, subject: string) =>
    sql<PhoneNotificationRow>`
      SELECT notification_id AS "notificationId", subject AS "subject", kind AS "kind",
             bot_id AS "botId", thread_id AS "threadId", request_id AS "requestId",
             body AS "body"
      FROM personal_phone_notifications
      WHERE notification_id = ${notificationId} AND subject = ${subject}
      LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const pruneNotifications = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const before = DateTime.formatIso(
      DateTime.subtract(now, { days: PHONE_NOTIFICATION_RETENTION_DAYS }),
    );
    yield* sql`DELETE FROM personal_phone_notifications WHERE created_at < ${before}`;
  });

  return {
    subjectOfSession,
    register,
    removeForSubject,
    removeToken,
    markError,
    markSent,
    list,
    purgeRevoked,
    recordNotification,
    findNotification,
    pruneNotifications,
  };
};

/**
 * Deletes every phone token whose sign-in session is revoked. Run after any
 * revoke so sign-out stops pushes at once; a failure is logged and never
 * blocks the revoke itself, because the sender purges again before it sends.
 */
export const purgeRevokedFcmTokens = (sql: SqlClient.SqlClient): Effect.Effect<void> =>
  makeFcmTokenStore(sql).purgeRevoked.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("phone push tokens could not be purged after a revoke"),
    ),
  );
