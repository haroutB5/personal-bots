import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export const BrowserLeaseOwnerType = Schema.Literals(["agent", "human"]);
export type BrowserLeaseOwnerType = typeof BrowserLeaseOwnerType.Type;

export const BrowserLeaseRow = Schema.Struct({
  profileId: Schema.String,
  ownerType: BrowserLeaseOwnerType,
  /** Thread id for agents, auth session id for humans, null when released. */
  ownerId: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  heartbeatAt: Schema.NullOr(Schema.String),
  /** Agents expire when idle; human control never expires on its own. */
  expiresAt: Schema.NullOr(Schema.String),
  /** Last http(s) page the agent had open; NULL when nothing restorable was recorded. */
  lastUrl: Schema.NullOr(Schema.String),
});
export type BrowserLeaseRow = typeof BrowserLeaseRow.Type;

export type BrowserLeaseRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class PersonalBrowserLeaseRepository extends Context.Service<
  PersonalBrowserLeaseRepository,
  {
    readonly load: (
      profileId: string,
    ) => Effect.Effect<Option.Option<BrowserLeaseRow>, BrowserLeaseRepositoryError>;
    readonly save: (row: BrowserLeaseRow) => Effect.Effect<void, BrowserLeaseRepositoryError>;
  }
>()("t3/personal/browser/PersonalBrowserLeaseRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): BrowserLeaseRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const loadRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: BrowserLeaseRow,
    execute: (profileId) =>
      sql`
        SELECT
          profile_id AS "profileId",
          owner_type AS "ownerType",
          owner_id AS "ownerId",
          generation AS "generation",
          heartbeat_at AS "heartbeatAt",
          expires_at AS "expiresAt",
          last_url AS "lastUrl"
        FROM personal_browser_leases
        WHERE profile_id = ${profileId}
      `,
  });

  const saveRow = SqlSchema.void({
    Request: BrowserLeaseRow,
    execute: (row) =>
      sql`
        INSERT INTO personal_browser_leases (
          profile_id, owner_type, owner_id, generation, heartbeat_at, expires_at, last_url
        )
        VALUES (
          ${row.profileId}, ${row.ownerType}, ${row.ownerId}, ${row.generation},
          ${row.heartbeatAt}, ${row.expiresAt}, ${row.lastUrl}
        )
        ON CONFLICT(profile_id) DO UPDATE SET
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          generation = excluded.generation,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at,
          last_url = excluded.last_url
      `,
  });

  return PersonalBrowserLeaseRepository.of({
    load: (profileId) =>
      loadRow(profileId).pipe(
        Effect.mapError(toRepositoryError("PersonalBrowserLeaseRepository.load")),
      ),
    save: (row) =>
      saveRow(row).pipe(Effect.mapError(toRepositoryError("PersonalBrowserLeaseRepository.save"))),
  });
});

export const layer = Layer.effect(PersonalBrowserLeaseRepository, make);
