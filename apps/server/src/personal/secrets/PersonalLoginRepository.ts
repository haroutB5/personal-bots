import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { PersonalBotId, PersonalLoginId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export interface StoredPersonalLogin {
  readonly loginId: PersonalLoginId;
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  readonly secretRef: string;
  readonly botIds: ReadonlyArray<PersonalBotId>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export type PersonalLoginRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const LoginJoinRow = Schema.Struct({
  loginId: PersonalLoginId,
  label: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  secretRef: Schema.String,
  botId: Schema.NullOr(PersonalBotId),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
const decodeLoginJoinRow = Schema.decodeUnknownEffect(LoginJoinRow);

const LOGIN_COLUMNS = `
  l.login_id AS "loginId",
  l.label AS "label",
  l.origin AS "origin",
  l.username AS "username",
  l.secret_ref AS "secretRef",
  g.bot_id AS "botId",
  l.created_at AS "createdAt",
  l.updated_at AS "updatedAt"
`;

export class PersonalLoginRepository extends Context.Service<
  PersonalLoginRepository,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<StoredPersonalLogin>,
      PersonalLoginRepositoryError
    >;
    readonly get: (
      loginId: PersonalLoginId,
    ) => Effect.Effect<Option.Option<StoredPersonalLogin>, PersonalLoginRepositoryError>;
    readonly create: (
      login: StoredPersonalLogin,
    ) => Effect.Effect<void, PersonalLoginRepositoryError>;
    readonly update: (
      login: StoredPersonalLogin,
    ) => Effect.Effect<boolean, PersonalLoginRepositoryError>;
    readonly remove: (
      loginId: PersonalLoginId,
    ) => Effect.Effect<boolean, PersonalLoginRepositoryError>;
  }
>()("t3/personal/secrets/PersonalLoginRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlError = (operation: string, cause: SqlError.SqlError) =>
    new PersistenceSqlError({ operation: `PersonalLoginRepository.${operation}`, cause });

  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) => effect.pipe(Effect.mapError((cause) => sqlError(operation, cause)));

  const decodeRows = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeLoginJoinRow(row).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError(`PersonalLoginRepository.${operation}`, cause),
        ),
      ),
    ).pipe(
      Effect.map((decoded) => {
        const grouped = new Map<string, StoredPersonalLogin>();
        for (const row of decoded) {
          const previous = grouped.get(row.loginId);
          grouped.set(row.loginId, {
            loginId: row.loginId,
            label: row.label,
            origin: row.origin,
            username: row.username,
            secretRef: row.secretRef,
            botIds:
              row.botId === null
                ? (previous?.botIds ?? [])
                : [...(previous?.botIds ?? []), row.botId],
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }
        return [...grouped.values()];
      }),
    );

  const select = (suffix: string) =>
    query(
      "select",
      sql.unsafe(`
        SELECT ${LOGIN_COLUMNS}
        FROM personal_logins l
        LEFT JOIN personal_login_grants g ON g.login_id = l.login_id
        ${suffix}
      `),
    ).pipe(Effect.flatMap((rows) => decodeRows("select", rows)));

  const writeGrants = (loginId: PersonalLoginId, botIds: ReadonlyArray<PersonalBotId>) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM personal_login_grants WHERE login_id = ${loginId}`;
      yield* Effect.forEach(
        [...new Set(botIds)],
        (botId) => sql`
          INSERT INTO personal_login_grants (login_id, bot_id)
          VALUES (${loginId}, ${botId})
        `,
        { discard: true },
      );
    });

  const list: PersonalLoginRepository["Service"]["list"] = () =>
    select("ORDER BY l.label COLLATE NOCASE ASC, l.login_id ASC");

  const get: PersonalLoginRepository["Service"]["get"] = (loginId) =>
    query(
      "get",
      sql`
        SELECT ${sql.literal(LOGIN_COLUMNS)}
        FROM personal_logins l
        LEFT JOIN personal_login_grants g ON g.login_id = l.login_id
        WHERE l.login_id = ${loginId}
        ORDER BY g.bot_id ASC
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeRows("get", rows)),
      Effect.map((logins) => Option.fromNullishOr(logins[0])),
    );

  const create: PersonalLoginRepository["Service"]["create"] = (login) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO personal_logins (
              login_id, label, origin, username, secret_ref, created_at, updated_at
            ) VALUES (
              ${login.loginId}, ${login.label}, ${login.origin}, ${login.username},
              ${login.secretRef}, ${DateTime.formatIso(login.createdAt)},
              ${DateTime.formatIso(login.updatedAt)}
            )
          `;
          yield* writeGrants(login.loginId, login.botIds);
        }),
      )
      .pipe(Effect.mapError((cause) => sqlError("create", cause)));

  const update: PersonalLoginRepository["Service"]["update"] = (login) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            UPDATE personal_logins
            SET label = ${login.label},
                origin = ${login.origin},
                username = ${login.username},
                secret_ref = ${login.secretRef},
                updated_at = ${DateTime.formatIso(login.updatedAt)}
            WHERE login_id = ${login.loginId}
            RETURNING login_id
          `;
          if (rows.length === 0) return false;
          yield* writeGrants(login.loginId, login.botIds);
          return true;
        }),
      )
      .pipe(Effect.mapError((cause) => sqlError("update", cause)));

  const remove: PersonalLoginRepository["Service"]["remove"] = (loginId) =>
    query(
      "remove",
      sql`DELETE FROM personal_logins WHERE login_id = ${loginId} RETURNING login_id`,
    ).pipe(Effect.map((rows) => rows.length > 0));

  return PersonalLoginRepository.of({ list, get, create, update, remove });
});

export const layer = Layer.effect(PersonalLoginRepository, make);
