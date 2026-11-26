import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersonalBotId,
  PersonalBotTeam,
  PersonalExternalMcpScope,
  PersonalExternalMcpServerId,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";

export type PersonalExternalMcpRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const ExternalMcpDbRow = Schema.Struct({
  serverId: PersonalExternalMcpServerId,
  slug: Schema.String,
  displayName: Schema.String,
  url: Schema.String,
  scope: PersonalExternalMcpScope,
  scopeId: Schema.NullOr(Schema.String),
  enabled: Schema.Number,
  credentialRef: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
type ExternalMcpDbRow = typeof ExternalMcpDbRow.Type;

export interface PersonalExternalMcpRow {
  readonly serverId: PersonalExternalMcpServerId;
  readonly slug: string;
  readonly displayName: string;
  readonly url: string;
  readonly scope: PersonalExternalMcpScope;
  readonly scopeId: string | null;
  readonly enabled: boolean;
  readonly credentialRef: string | null;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export interface InsertPersonalExternalMcpInput {
  readonly serverId: PersonalExternalMcpServerId;
  readonly slug: string;
  readonly displayName: string;
  readonly url: string;
  readonly scope: PersonalExternalMcpScope;
  readonly scopeId: string | null;
  readonly enabled: boolean;
  readonly credentialRef: string | null;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export interface UpdatePersonalExternalMcpInput {
  readonly serverId: PersonalExternalMcpServerId;
  readonly slug: string;
  readonly displayName: string;
  readonly url: string;
  readonly scope: PersonalExternalMcpScope;
  readonly scopeId: string | null;
  readonly enabled: boolean;
  readonly credentialRef: string | null;
  readonly updatedAt: DateTime.Utc;
}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ExternalMcpDbRow));

const toDomain = (row: ExternalMcpDbRow): PersonalExternalMcpRow => ({
  serverId: row.serverId,
  slug: row.slug,
  displayName: row.displayName,
  url: row.url,
  scope: row.scope,
  scopeId: row.scopeId,
  enabled: row.enabled !== 0,
  credentialRef: row.credentialRef,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export interface PersonalExternalMcpRepositoryShape {
  readonly list: () => Effect.Effect<
    ReadonlyArray<PersonalExternalMcpRow>,
    PersonalExternalMcpRepositoryError
  >;
  readonly getById: (
    serverId: PersonalExternalMcpServerId,
  ) => Effect.Effect<Option.Option<PersonalExternalMcpRow>, PersonalExternalMcpRepositoryError>;
  readonly getBySlug: (
    slug: string,
  ) => Effect.Effect<Option.Option<PersonalExternalMcpRow>, PersonalExternalMcpRepositoryError>;
  readonly listEnabledForBot: (input: {
    readonly botId: PersonalBotId;
    readonly team: PersonalBotTeam;
  }) => Effect.Effect<ReadonlyArray<PersonalExternalMcpRow>, PersonalExternalMcpRepositoryError>;
  readonly insert: (
    input: InsertPersonalExternalMcpInput,
  ) => Effect.Effect<void, PersonalExternalMcpRepositoryError>;
  readonly update: (
    input: UpdatePersonalExternalMcpInput,
  ) => Effect.Effect<void, PersonalExternalMcpRepositoryError>;
  readonly deleteById: (
    serverId: PersonalExternalMcpServerId,
  ) => Effect.Effect<void, PersonalExternalMcpRepositoryError>;
}

export class PersonalExternalMcpRepository extends Context.Service<
  PersonalExternalMcpRepository,
  PersonalExternalMcpRepositoryShape
>()("t3/personal/externalMcp/PersonalExternalMcpRepository") {}

const SELECT_COLUMNS = `
  server_id AS "serverId",
  slug AS "slug",
  display_name AS "displayName",
  url AS "url",
  scope AS "scope",
  scope_id AS "scopeId",
  enabled AS "enabled",
  credential_ref AS "credentialRef",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decode = (operation: string, rows: ReadonlyArray<unknown>) =>
    decodeRows(rows).pipe(
      Effect.map((decoded) => decoded.map(toDomain)),
      Effect.mapError(
        (cause) =>
          new PersistenceDecodeError({
            operation,
            issue: cause.message,
            cause,
          }),
      ),
    );

  const list: PersonalExternalMcpRepositoryShape["list"] = () =>
    sql
      .unsafe(
        `SELECT ${SELECT_COLUMNS} FROM personal_external_mcp_servers ORDER BY created_at ASC, slug ASC`,
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.list")),
        Effect.flatMap((rows) => decode("PersonalExternalMcpRepository.list", rows)),
      );

  const getById: PersonalExternalMcpRepositoryShape["getById"] = (serverId) =>
    sql`
      SELECT
        server_id AS "serverId",
        slug AS "slug",
        display_name AS "displayName",
        url AS "url",
        scope AS "scope",
        scope_id AS "scopeId",
        enabled AS "enabled",
        credential_ref AS "credentialRef",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM personal_external_mcp_servers
      WHERE server_id = ${serverId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.getById")),
      Effect.flatMap((rows) => decode("PersonalExternalMcpRepository.getById", rows)),
      Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
    );

  const getBySlug: PersonalExternalMcpRepositoryShape["getBySlug"] = (slug) =>
    sql`
      SELECT
        server_id AS "serverId",
        slug AS "slug",
        display_name AS "displayName",
        url AS "url",
        scope AS "scope",
        scope_id AS "scopeId",
        enabled AS "enabled",
        credential_ref AS "credentialRef",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM personal_external_mcp_servers
      WHERE slug = ${slug}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.getBySlug")),
      Effect.flatMap((rows) => decode("PersonalExternalMcpRepository.getBySlug", rows)),
      Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
    );

  const listEnabledForBot: PersonalExternalMcpRepositoryShape["listEnabledForBot"] = ({
    botId,
    team,
  }) =>
    sql`
      SELECT
        server_id AS "serverId",
        slug AS "slug",
        display_name AS "displayName",
        url AS "url",
        scope AS "scope",
        scope_id AS "scopeId",
        enabled AS "enabled",
        credential_ref AS "credentialRef",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM personal_external_mcp_servers
      WHERE enabled = 1
        AND (
          scope = 'shared'
          OR (scope = 'team' AND scope_id = ${team})
          OR (scope = 'bot' AND scope_id = ${botId})
        )
      ORDER BY slug ASC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.listEnabledForBot")),
      Effect.flatMap((rows) => decode("PersonalExternalMcpRepository.listEnabledForBot", rows)),
    );

  const insert: PersonalExternalMcpRepositoryShape["insert"] = (input) =>
    sql`
      INSERT INTO personal_external_mcp_servers (
        server_id,
        slug,
        display_name,
        url,
        scope,
        scope_id,
        enabled,
        credential_ref,
        created_at,
        updated_at
      ) VALUES (
        ${input.serverId},
        ${input.slug},
        ${input.displayName},
        ${input.url},
        ${input.scope},
        ${input.scopeId},
        ${input.enabled ? 1 : 0},
        ${input.credentialRef},
        ${DateTime.formatIso(input.createdAt)},
        ${DateTime.formatIso(input.updatedAt)}
      )
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.insert")),
    );

  const update: PersonalExternalMcpRepositoryShape["update"] = (input) =>
    sql`
      UPDATE personal_external_mcp_servers
      SET
        slug = ${input.slug},
        display_name = ${input.displayName},
        url = ${input.url},
        scope = ${input.scope},
        scope_id = ${input.scopeId},
        enabled = ${input.enabled ? 1 : 0},
        credential_ref = ${input.credentialRef},
        updated_at = ${DateTime.formatIso(input.updatedAt)}
      WHERE server_id = ${input.serverId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.update")),
    );

  const deleteById: PersonalExternalMcpRepositoryShape["deleteById"] = (serverId) =>
    sql`
      DELETE FROM personal_external_mcp_servers
      WHERE server_id = ${serverId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PersonalExternalMcpRepository.deleteById")),
    );

  return {
    list,
    getById,
    getBySlug,
    listEnabledForBot,
    insert,
    update,
    deleteById,
  } satisfies PersonalExternalMcpRepositoryShape;
});

export const layer = Layer.effect(PersonalExternalMcpRepository, make);
