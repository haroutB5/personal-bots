import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "145_PersonalPushSubscriptionSession",
  (it) => {
    it.effect("adds a nullable session column and keeps every subscription and outbox row", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 144 });
        yield* sql`
          INSERT INTO personal_push_subscriptions (
            subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at,
            last_success_at
          )
          VALUES ('sub-1', 'https://web.push.apple.com/one', 'k1', 'a1', 'iPhone',
                  '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
                  '2026-10-02T00:00:00.000Z'),
                 ('sub-2', 'https://fcm.googleapis.com/fcm/send/two', 'k2', 'a2', '',
                  '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', NULL)
        `;
        yield* sql`
          INSERT INTO personal_notification_outbox (
            event_id, subscription_id, payload_json, attempts, status, next_attempt_at,
            last_error, created_at, updated_at
          )
          VALUES ('e1', 'sub-1', '{}', 0, 'pending', '2026-10-04T00:00:00.000Z', NULL,
                  '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z'),
                 ('e2', 'sub-1', '{}', 1, 'sent', '2026-10-04T00:00:00.000Z', NULL,
                  '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
        `;

        yield* runMigrations({ toMigrationInclusive: 145 });

        const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
          SELECT name, "notnull" FROM pragma_table_info('personal_push_subscriptions')
          WHERE name = 'auth_session_id'
        `;
        expect(columns).toEqual([{ name: "auth_session_id", notnull: 0 }]);
        const subscriptions = yield* sql<{
          readonly id: string;
          readonly endpoint: string;
          readonly lastSuccessAt: string | null;
          readonly session: string | null;
        }>`
          SELECT subscription_id AS "id", endpoint AS "endpoint",
                 last_success_at AS "lastSuccessAt", auth_session_id AS "session"
          FROM personal_push_subscriptions ORDER BY subscription_id
        `;
        expect(subscriptions).toEqual([
          {
            id: "sub-1",
            endpoint: "https://web.push.apple.com/one",
            lastSuccessAt: "2026-10-02T00:00:00.000Z",
            session: null,
          },
          {
            id: "sub-2",
            endpoint: "https://fcm.googleapis.com/fcm/send/two",
            lastSuccessAt: null,
            session: null,
          },
        ]);
        const outbox = yield* sql<{ readonly event: string; readonly status: string }>`
          SELECT event_id AS "event", status AS "status"
          FROM personal_notification_outbox ORDER BY event_id
        `;
        expect(outbox).toEqual([
          { event: "e1", status: "pending" },
          { event: "e2", status: "sent" },
        ]);
        const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_index_list('personal_push_subscriptions')
          WHERE name = 'idx_personal_push_subscriptions_session'
        `;
        expect(indexes.length).toBe(1);
      }),
    );
  },
);
