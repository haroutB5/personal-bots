/**
 * The credential protections that must outlive the server process.
 *
 * The browser profile is persistent: its cookies, and therefore the signed-in
 * sessions a saved login created, survive both a Chrome close and a server
 * restart. The protections that gate those sessions used to live only in
 * process memory, so a restart left an authenticated profile with none of them
 * (audit finding #3). One row per profile, read once at boot and rewritten
 * whole on every change.
 *
 * There is deliberately no clear operation. Nothing the user can do today
 * un-authenticates the shared profile, so nothing may drop the protections
 * that stand in front of it; they are cleared only by deleting the profile.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export const BrowserProtectionState = Schema.Struct({
  profileId: Schema.String,
  /** A saved login has been used in this profile, so page scripts stay disabled. */
  loginUsed: Schema.Boolean,
  /** Origins where a model-provided script was allowed to run. */
  taintedOrigins: Schema.Array(Schema.String),
});
export type BrowserProtectionState = typeof BrowserProtectionState.Type;

/** The row as SQLite holds it: a flag as 0/1 and two JSON arrays. */
const ProtectionRow = Schema.Struct({
  profileId: Schema.String,
  loginUsed: Schema.Int,
  taintedOrigins: Schema.fromJsonString(Schema.Array(Schema.String)),
});

const encodeTaintedOrigins = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export type BrowserProtectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class PersonalBrowserProtectionRepository extends Context.Service<
  PersonalBrowserProtectionRepository,
  {
    readonly load: (
      profileId: string,
    ) => Effect.Effect<Option.Option<BrowserProtectionState>, BrowserProtectionRepositoryError>;
    readonly save: (
      state: BrowserProtectionState,
    ) => Effect.Effect<void, BrowserProtectionRepositoryError>;
  }
>()("t3/personal/browser/PersonalBrowserProtectionRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): BrowserProtectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const loadRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProtectionRow,
    execute: (profileId) =>
      sql`
        SELECT
          profile_id AS "profileId",
          login_used AS "loginUsed",
          tainted_origins AS "taintedOrigins"
        FROM personal_browser_protection
        WHERE profile_id = ${profileId}
      `,
  });

  const saveRow = (state: BrowserProtectionState) =>
    sql`
      INSERT INTO personal_browser_protection (
        profile_id, login_used, tainted_origins
      )
      VALUES (
        ${state.profileId}, ${state.loginUsed ? 1 : 0},
        ${encodeTaintedOrigins(state.taintedOrigins)}
      )
      ON CONFLICT(profile_id) DO UPDATE SET
        login_used = excluded.login_used,
        tainted_origins = excluded.tainted_origins
    `;

  return PersonalBrowserProtectionRepository.of({
    load: (profileId) =>
      loadRow(profileId).pipe(
        Effect.map(
          Option.map((row): BrowserProtectionState => ({
            profileId: row.profileId,
            loginUsed: row.loginUsed !== 0,
            taintedOrigins: row.taintedOrigins,
          })),
        ),
        Effect.mapError(toRepositoryError("PersonalBrowserProtectionRepository.load")),
      ),
    save: (state) =>
      saveRow(state).pipe(
        Effect.asVoid,
        Effect.mapError(toRepositoryError("PersonalBrowserProtectionRepository.save")),
      ),
  });
});

export const layer = Layer.effect(PersonalBrowserProtectionRepository, make);
