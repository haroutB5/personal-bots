import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { PersonalLoginId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export interface StoredPersonalLogin {
  readonly loginId: PersonalLoginId;
  readonly label: string;
  readonly origin: string;
  readonly username: string;
  readonly secretRef: string;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export type PersonalLoginRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const LoginRow = Schema.Struct({
  loginId: PersonalLoginId,
  label: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  secretRef: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
const decodeLoginRow = Schema.decodeUnknownEffect(LoginRow);

const LOGIN_COLUMNS = `
  l.login_id AS "loginId",
  l.label AS "label",
  l.origin AS "origin",
  l.username AS "username",
  l.secret_ref AS "secretRef",
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
      decodeLoginRow(row).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError(`PersonalLoginRepository.${operation}`, cause),
        ),
      ),
    );

  const select = (suffix: string) =>
    query(
      "select",
      sql.unsafe(`
        SELECT ${LOGIN_COLUMNS}
        FROM personal_logins l
        ${suffix}
      `),
    ).pipe(Effect.flatMap((rows) => decodeRows("select", rows)));

  const list: PersonalLoginRepository["Service"]["list"] = () =>
    select("ORDER BY l.label COLLATE NOCASE ASC, l.login_id ASC");

  const get: PersonalLoginRepository["Service"]["get"] = (loginId) =>
    query(
      "get",
      sql`
        SELECT ${sql.literal(LOGIN_COLUMNS)}
        FROM personal_logins l
        WHERE l.login_id = ${loginId}
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeRows("get", rows)),
      Effect.map((logins) => Option.fromNullishOr(logins[0])),
    );

  const create: PersonalLoginRepository["Service"]["create"] = (login) =>
    query(
      "create",
      sql`
        INSERT INTO personal_logins (
          login_id, label, origin, username, secret_ref, created_at, updated_at
        ) VALUES (
          ${login.loginId}, ${login.label}, ${login.origin}, ${login.username},
          ${login.secretRef}, ${DateTime.formatIso(login.createdAt)},
          ${DateTime.formatIso(login.updatedAt)}
        )
      `,
    ).pipe(Effect.asVoid);

  const update: PersonalLoginRepository["Service"]["update"] = (login) =>
    query(
      "update",
      sql`
        UPDATE personal_logins
        SET label = ${login.label},
            origin = ${login.origin},
            username = ${login.username},
            secret_ref = ${login.secretRef},
            updated_at = ${DateTime.formatIso(login.updatedAt)}
        WHERE login_id = ${login.loginId}
        RETURNING login_id
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const remove: PersonalLoginRepository["Service"]["remove"] = (loginId) =>
    query(
      "remove",
      sql`DELETE FROM personal_logins WHERE login_id = ${loginId} RETURNING login_id`,
    ).pipe(Effect.map((rows) => rows.length > 0));

  return PersonalLoginRepository.of({ list, get, create, update, remove });
});

export const layer = Layer.effect(PersonalLoginRepository, make);
