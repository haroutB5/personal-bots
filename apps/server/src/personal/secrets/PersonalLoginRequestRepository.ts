import { PersonalLoginRequest, PersonalLoginsError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class PersonalLoginRequestRepository extends Context.Service<
  PersonalLoginRequestRepository,
  {
    readonly list: (
      threadId?: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PersonalLoginRequest>, PersonalLoginsError>;
    readonly insert: (row: PersonalLoginRequest) => Effect.Effect<void, PersonalLoginsError>;
    readonly transition: (
      row: PersonalLoginRequest,
      expected: PersonalLoginRequest["status"],
    ) => Effect.Effect<boolean, PersonalLoginsError>;
  }
>()("t3/personal/secrets/PersonalLoginRequestRepository") {}

export const layer = Layer.effect(
  PersonalLoginRequestRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const decode = Schema.decodeUnknownEffect(Schema.Array(PersonalLoginRequest));
    const columns =
      sql.literal(`request_id AS "requestId", task_id AS "taskId", thread_id AS "threadId",
    bot_id AS "botId", origin, label, reason, tab_id AS "tabId", status,
    saved, created_at AS "createdAt", expires_at AS "expiresAt"`);
    const list: PersonalLoginRequestRepository["Service"]["list"] = (threadId) =>
      (threadId === undefined
        ? sql`SELECT ${columns} FROM personal_login_requests WHERE status IN ('pending', 'filling') ORDER BY created_at`
        : sql`SELECT ${columns} FROM personal_login_requests WHERE thread_id = ${threadId} ORDER BY created_at`
      ).pipe(
        Effect.flatMap((rows) => decode(rows.map((row) => ({ ...row, saved: row.saved === 1 })))),
        Effect.mapError(
          () => new PersonalLoginsError({ message: "Could not read login requests." }),
        ),
      );
    const insert: PersonalLoginRequestRepository["Service"]["insert"] = (row) =>
      sql`
    INSERT INTO personal_login_requests
      (request_id, task_id, thread_id, bot_id, origin, label, reason, tab_id, status, saved, created_at, expires_at)
    VALUES (${row.requestId}, ${row.taskId}, ${row.threadId}, ${row.botId}, ${row.origin}, ${row.label},
      ${row.reason}, ${row.tabId}, ${row.status}, ${row.saved ? 1 : 0}, ${row.createdAt}, ${row.expiresAt})
  `.pipe(
        Effect.asVoid,
        Effect.mapError(
          () => new PersonalLoginsError({ message: "Could not create login request." }),
        ),
      );
    const transition: PersonalLoginRequestRepository["Service"]["transition"] = (row, expected) =>
      sql`
    UPDATE personal_login_requests SET status = ${row.status}, saved = ${row.saved ? 1 : 0}
    WHERE request_id = ${row.requestId} AND status = ${expected}
    RETURNING request_id
  `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          () => new PersonalLoginsError({ message: "Could not update login request." }),
        ),
      );
    return PersonalLoginRequestRepository.of({ list, insert, transition });
  }),
);
