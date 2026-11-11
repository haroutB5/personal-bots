import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import { purgeDeadPushRecipients, purgeRevokedPushRecipients } from "./pushRecipients.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const session = (id: string, revokedAt: string | null, expiresAt: string) =>
    sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
      VALUES (${id}, 'owner', '[]', 'one-time-token', '2026-01-01T00:00:00.000Z', ${expiresAt}, ${revokedAt})
    `;
  yield* session("live", null, "2099-01-01T00:00:00.000Z");
  yield* session("revoked", "2026-01-02T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
  yield* session("expired", null, "2026-01-02T00:00:00.000Z");
  const web = (id: string, session: string | null) =>
    sql`
      INSERT INTO personal_push_subscriptions (
        subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at, auth_session_id
      )
      VALUES (${id}, ${`https://web.push.apple.com/${id}`}, 'k', 'a', '', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z', ${session})
    `;
  yield* web("web-live", "live");
  yield* web("web-revoked", "revoked");
  yield* web("web-expired", "expired");
  yield* web("web-unknown", "no-such-session");
  yield* web("web-null", null);
  const token = (id: string, session: string) =>
    sql`
      INSERT INTO personal_fcm_tokens (
        token, auth_session_id, subject, app_version, created_at, last_seen_at, last_error
      )
      VALUES (${id}, ${session}, 'owner', '1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
    `;
  yield* token("tok-live", "live");
  yield* token("tok-revoked", "revoked");
  yield* token("tok-expired", "expired");
  const outbox = (event: string, subscription: string, status: string) =>
    sql`
      INSERT INTO personal_notification_outbox (
        event_id, subscription_id, payload_json, attempts, status, next_attempt_at,
        last_error, created_at, updated_at
      )
      VALUES (${event}, ${subscription}, '{}', 0, ${status}, '2026-01-01T00:00:00.000Z', NULL,
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `;
  yield* outbox("e1", "web-live", "pending");
  yield* outbox("e1", "web-revoked", "pending");
  yield* outbox("e2", "web-revoked", "sent");
});

const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const web = yield* sql<{ readonly id: string }>`
    SELECT subscription_id AS "id" FROM personal_push_subscriptions ORDER BY 1
  `;
  const tokens = yield* sql<{ readonly id: string }>`
    SELECT token AS "id" FROM personal_fcm_tokens ORDER BY 1
  `;
  const outbox = yield* sql<{ readonly id: string }>`
    SELECT event_id || ':' || subscription_id || ':' || status AS "id"
    FROM personal_notification_outbox ORDER BY 1
  `;
  return {
    web: web.map((row) => row.id),
    tokens: tokens.map((row) => row.id),
    outbox: outbox.map((row) => row.id),
  };
});

const expectedAfterPurge = {
  web: ["web-live"],
  tokens: ["tok-live"],
  outbox: ["e1:web-live:pending", "e2:web-revoked:sent"],
};

it.effect("the purge removes every browser and phone whose session is not live", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* purgeDeadPushRecipients(yield* SqlClient.SqlClient);
    expect(yield* state).toEqual(expectedAfterPurge);
  }).pipe(Effect.provide(personalTestDatabase)),
);

it.effect("the revoke-path purge does the same and a second run changes nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* purgeRevokedPushRecipients(sql);
    yield* purgeRevokedPushRecipients(sql);
    expect(yield* state).toEqual(expectedAfterPurge);
  }).pipe(Effect.provide(personalTestDatabase)),
);
