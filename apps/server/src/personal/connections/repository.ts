import {
  ConnectionId,
  EMPTY_PERSONAL_CONNECTION_SETTINGS,
  type PersonalConnection,
  type PersonalConnectionSettings,
  PersonalConnectionStatus,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export interface StoredPersonalConnection {
  readonly connectionId: ConnectionId;
  readonly vendorId: PersonalConnectionVendorId;
  readonly status: typeof PersonalConnectionStatus.Type;
  readonly account: PersonalConnection["account"];
  readonly verifiedCapabilities: ReadonlyArray<string>;
  /** Owner-visible knobs. Never a credential; a browser-session vendor has none. */
  readonly settings: PersonalConnectionSettings;
  readonly credentialRef: string;
  readonly credentialVersion: number;
  readonly lastValidatedAt: DateTime.Utc | null;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export type PersonalConnectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const presentConnection = (stored: StoredPersonalConnection): PersonalConnection => ({
  connectionId: stored.connectionId,
  vendorId: stored.vendorId,
  status: stored.status,
  account: stored.account,
  verifiedCapabilities: [...stored.verifiedCapabilities],
  settings: stored.settings,
  credentialVersion: stored.credentialVersion,
  lastValidatedAt: stored.lastValidatedAt,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
});

const ConnectionRow = Schema.Struct({
  connectionId: ConnectionId,
  vendorId: PersonalConnectionVendorId,
  status: PersonalConnectionStatus,
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  teamId: Schema.NullOr(Schema.String),
  teamName: Schema.NullOr(Schema.String),
  capabilitiesJson: Schema.fromJsonString(Schema.Array(Schema.String)),
  // Lenient on the way in on purpose: rows written before a setting existed
  // simply do not carry it, and that is not a corrupt row.
  settingsJson: Schema.fromJsonString(
    Schema.Struct({
      whatsappDailySendCap: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    }),
  ),
  credentialRef: Schema.String,
  credentialVersion: Schema.Int,
  lastValidatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
const decodeRow = Schema.decodeUnknownEffect(ConnectionRow);

const COLUMNS = `
  connection_id AS "connectionId",
  vendor_id AS "vendorId",
  status AS "status",
  account_id AS "accountId",
  account_name AS "accountName",
  team_id AS "teamId",
  team_name AS "teamName",
  verified_capabilities_json AS "capabilitiesJson",
  settings_json AS "settingsJson",
  credential_ref AS "credentialRef",
  credential_version AS "credentialVersion",
  last_validated_at AS "lastValidatedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class PersonalConnectionRepository extends Context.Service<
  PersonalConnectionRepository,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<StoredPersonalConnection>,
      PersonalConnectionRepositoryError
    >;
    readonly get: (
      connectionId: ConnectionId,
    ) => Effect.Effect<Option.Option<StoredPersonalConnection>, PersonalConnectionRepositoryError>;
    readonly getByVendor: (
      vendor: PersonalConnectionVendorId,
    ) => Effect.Effect<Option.Option<StoredPersonalConnection>, PersonalConnectionRepositoryError>;
    readonly create: (
      connection: StoredPersonalConnection,
    ) => Effect.Effect<void, PersonalConnectionRepositoryError>;
    readonly update: (
      connection: StoredPersonalConnection,
    ) => Effect.Effect<boolean, PersonalConnectionRepositoryError>;
    readonly remove: (
      connectionId: ConnectionId,
    ) => Effect.Effect<boolean, PersonalConnectionRepositoryError>;
  }
>()("t3/personal/connections/repository/PersonalConnectionRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: `PersonalConnectionRepository.${operation}`,
            cause,
          }),
      ),
    );
  const decode = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeRow(row).pipe(
        Effect.map((decoded): StoredPersonalConnection => ({
          connectionId: decoded.connectionId,
          vendorId: decoded.vendorId,
          status: decoded.status,
          account:
            decoded.accountId === null || decoded.accountName === null
              ? null
              : {
                  accountId: decoded.accountId,
                  accountName: decoded.accountName,
                  teamId: decoded.teamId,
                  teamName: decoded.teamName,
                },
          verifiedCapabilities: decoded.capabilitiesJson,
          settings: {
            ...EMPTY_PERSONAL_CONNECTION_SETTINGS,
            whatsappDailySendCap: decoded.settingsJson.whatsappDailySendCap ?? null,
          },
          credentialRef: decoded.credentialRef,
          credentialVersion: decoded.credentialVersion,
          lastValidatedAt: decoded.lastValidatedAt,
          createdAt: decoded.createdAt,
          updatedAt: decoded.updatedAt,
        })),
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError(
            `PersonalConnectionRepository.${operation}`,
            cause,
          ),
        ),
      ),
    );
  const one = (operation: string, rows: ReadonlyArray<unknown>) =>
    decode(operation, rows).pipe(Effect.map((values) => Option.fromNullishOr(values[0])));

  const list: PersonalConnectionRepository["Service"]["list"] = () =>
    query(
      "list",
      sql`SELECT ${sql.literal(COLUMNS)} FROM personal_connections ORDER BY vendor_id ASC`,
    ).pipe(Effect.flatMap((rows) => decode("list", rows)));

  const get: PersonalConnectionRepository["Service"]["get"] = (connectionId) =>
    query(
      "get",
      sql`SELECT ${sql.literal(COLUMNS)} FROM personal_connections WHERE connection_id = ${connectionId}`,
    ).pipe(Effect.flatMap((rows) => one("get", rows)));

  const getByVendor: PersonalConnectionRepository["Service"]["getByVendor"] = (vendor) =>
    query(
      "getByVendor",
      sql`SELECT ${sql.literal(COLUMNS)} FROM personal_connections WHERE vendor_id = ${vendor}`,
    ).pipe(Effect.flatMap((rows) => one("getByVendor", rows)));

  const create: PersonalConnectionRepository["Service"]["create"] = (connection) =>
    query(
      "create",
      sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, account_id, account_name, team_id, team_name,
          verified_capabilities_json, settings_json, credential_ref, credential_version,
          last_validated_at, created_at, updated_at
        ) VALUES (
          ${connection.connectionId}, ${connection.vendorId}, ${connection.status},
          ${connection.account?.accountId ?? null}, ${connection.account?.accountName ?? null},
          ${connection.account?.teamId ?? null}, ${connection.account?.teamName ?? null},
          ${JSON.stringify(connection.verifiedCapabilities)},
          ${JSON.stringify(connection.settings)},
          ${connection.credentialRef}, ${connection.credentialVersion},
          ${connection.lastValidatedAt === null ? null : DateTime.formatIso(connection.lastValidatedAt)},
          ${DateTime.formatIso(connection.createdAt)}, ${DateTime.formatIso(connection.updatedAt)}
        )
      `,
    ).pipe(Effect.asVoid);

  const update: PersonalConnectionRepository["Service"]["update"] = (connection) =>
    query(
      "update",
      sql`
        UPDATE personal_connections
        SET status = ${connection.status},
            account_id = ${connection.account?.accountId ?? null},
            account_name = ${connection.account?.accountName ?? null},
            team_id = ${connection.account?.teamId ?? null},
            team_name = ${connection.account?.teamName ?? null},
            verified_capabilities_json = ${JSON.stringify(connection.verifiedCapabilities)},
            settings_json = ${JSON.stringify(connection.settings)},
            credential_ref = ${connection.credentialRef},
            credential_version = ${connection.credentialVersion},
            last_validated_at = ${connection.lastValidatedAt === null ? null : DateTime.formatIso(connection.lastValidatedAt)},
            updated_at = ${DateTime.formatIso(connection.updatedAt)}
        WHERE connection_id = ${connection.connectionId}
        RETURNING connection_id
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const remove: PersonalConnectionRepository["Service"]["remove"] = (connectionId) =>
    query(
      "remove",
      sql`DELETE FROM personal_connections WHERE connection_id = ${connectionId} RETURNING connection_id`,
    ).pipe(Effect.map((rows) => rows.length > 0));

  return PersonalConnectionRepository.of({ list, get, getByVendor, create, update, remove });
});

export const layer = Layer.effect(PersonalConnectionRepository, make);
