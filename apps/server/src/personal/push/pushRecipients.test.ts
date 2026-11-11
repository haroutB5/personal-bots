import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import {
  followSessionSuccessor,
  purgeDeadPushRecipients,
  purgeRevokedPushRecipients,
} from "./pushRecipients.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(Date.parse("2026-06-01T00:00:00Z"));
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

const insertSession = (id: string, revokedAt: string | null, expiresAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
      VALUES (${id}, 'owner', '[]', 'dpop-access-token', '2026-01-01T00:00:00.000Z', ${expiresAt}, ${revokedAt})
    `;
  });

const insertBrowser = (id: string, session: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_push_subscriptions (
        subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at, auth_session_id
      )
      VALUES (${id}, ${`https://web.push.apple.com/${id}`}, 'k', 'a', '', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z', ${session})
    `;
  });

const insertPhone = (token: string, session: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_fcm_tokens (
        token, auth_session_id, subject, app_version, created_at, last_seen_at, last_error
      )
      VALUES (${token}, ${session}, 'owner', '1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
    `;
  });

const boundSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const web = yield* sql<{ readonly id: string }>`
    SELECT subscription_id || '>' || auth_session_id AS "id" FROM personal_push_subscriptions ORDER BY 1
  `;
  const phones = yield* sql<{ readonly id: string }>`
    SELECT token || '>' || auth_session_id AS "id" FROM personal_fcm_tokens ORDER BY 1
  `;
  return { web: web.map((row) => row.id), phones: phones.map((row) => row.id) };
});

const NOW = "2026-06-01T00:00:00Z";

it.effect("following a live successor moves browser and phone rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse(NOW));
    yield* insertSession("s1", null, "2026-05-31T23:59:00.000Z");
    yield* insertSession("s2", null, "2026-06-01T01:00:00.000Z");
    yield* insertSession("s3", null, "2026-06-01T01:00:00.000Z");
    yield* insertBrowser("web-1", "s1");
    yield* insertBrowser("web-other", "s3");
    yield* insertPhone("tok-1", "s1");
    yield* insertPhone("tok-other", "s3");

    yield* followSessionSuccessor(sql, "s1", "s2");
    const expected = {
      web: ["web-1>s2", "web-other>s3"],
      phones: ["tok-1>s2", "tok-other>s3"],
    };
    expect(yield* boundSessions).toEqual(expected);

    yield* followSessionSuccessor(sql, "s1", "s2");
    expect(yield* boundSessions).toEqual(expected);
  }).pipe(Effect.provide(personalTestDatabase)),
);

it.effect("following a revoked or expired successor moves nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse(NOW));
    yield* insertSession("s1", null, "2026-06-01T00:30:00.000Z");
    yield* insertSession("revoked", "2026-05-31T00:00:00.000Z", "2026-06-01T01:00:00.000Z");
    yield* insertSession("expired", null, "2026-05-31T23:59:00.000Z");
    yield* insertBrowser("web-1", "s1");
    yield* insertPhone("tok-1", "s1");

    yield* followSessionSuccessor(sql, "s1", "revoked");
    yield* followSessionSuccessor(sql, "s1", "expired");
    yield* followSessionSuccessor(sql, "s1", "no-such-session");
    expect(yield* boundSessions).toEqual({ web: ["web-1>s1"], phones: ["tok-1>s1"] });

    yield* insertSession("live", null, "2026-06-01T01:00:00.000Z");
    yield* followSessionSuccessor(sql, "s1", "live");
    expect(yield* boundSessions).toEqual({ web: ["web-1>live"], phones: ["tok-1>live"] });
  }).pipe(Effect.provide(personalTestDatabase)),
);

it.effect("purge keeps a just-expired row for the grace and deletes revoked rows at once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse("2026-06-01T00:00:00Z"));
    yield* insertSession("expiring", null, "2026-06-01T00:10:00.000Z");
    yield* insertSession("revoked", "2026-05-31T23:59:59.000Z", "2026-06-01T01:00:00.000Z");
    yield* insertBrowser("web-expiring", "expiring");
    yield* insertPhone("tok-expiring", "expiring");
    yield* insertBrowser("web-revoked", "revoked");
    yield* insertPhone("tok-revoked", "revoked");

    yield* purgeDeadPushRecipients(sql);
    expect(yield* boundSessions).toEqual({
      web: ["web-expiring>expiring"],
      phones: ["tok-expiring>expiring"],
    });

    yield* TestClock.setTime(Date.parse("2026-06-01T00:10:30Z"));
    yield* purgeDeadPushRecipients(sql);
    expect(yield* boundSessions).toEqual({
      web: ["web-expiring>expiring"],
      phones: ["tok-expiring>expiring"],
    });

    yield* TestClock.setTime(Date.parse("2026-06-01T00:11:01Z"));
    yield* purgeDeadPushRecipients(sql);
    expect(yield* boundSessions).toEqual({ web: [], phones: [] });
  }).pipe(Effect.provide(personalTestDatabase)),
);
