import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per device. The endpoint is the push service's capability URL.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_push_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_success_at TEXT,
      last_failure_at TEXT,
      last_error TEXT
    )
  `;

  // status: pending | sent | failed | expired. The unique pair dedupes an
  // event replayed after a restart.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_notification_outbox (
      event_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (event_id, subscription_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_notification_outbox_due
    ON personal_notification_outbox(status, next_attempt_at)
  `;
});
