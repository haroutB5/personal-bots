import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const purgeDeadPushRecipients = (_sql: SqlClient.SqlClient) => Effect.void;
export const purgeRevokedPushRecipients = (_sql: SqlClient.SqlClient): Effect.Effect<void> =>
  Effect.void;
