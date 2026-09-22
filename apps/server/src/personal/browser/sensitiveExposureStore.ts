import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

/**
 * The persisted sensitive-site taint (migration 077).
 *
 * Plain functions over the SQL client rather than a service, because three
 * owners write it and they must agree on the keys: the browser (a page was
 * open, the owner approved a destination), the memory service (a task summary
 * from a tainted tree is not remembered) and the group round (a member's reply
 * carries its taint into the group, and the group's into the next speaker).
 * The keys are the only contract, so they are built here and nowhere else.
 */

export const threadExposureKey = (threadId: string) => `thread:${threadId}`;
export const rootExposureKey = (rootTaskId: string) => `root:${rootTaskId}`;
export const groupExposureKey = (groupId: string) => `group:${groupId}`;

export type SensitiveExposureKind = "source" | "approved";

export interface SensitiveExposure {
  readonly sources: Set<string>;
  readonly approved: Set<string>;
}

export const makeSensitiveExposureStore = (sql: SqlClient.SqlClient) => {
  /** Adds `value` under every key. Idempotent. */
  const record = (
    keys: ReadonlyArray<string>,
    kind: SensitiveExposureKind,
    value: string,
  ): Effect.Effect<void, SqlError.SqlError> =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const key of keys) {
        yield* sql`
          INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
          VALUES (${key}, ${kind}, ${value}, ${now})
          ON CONFLICT DO NOTHING
        `;
      }
    });

  /** Everything recorded under any of `keys`, merged. */
  const read = (
    keys: ReadonlyArray<string>,
  ): Effect.Effect<SensitiveExposure, SqlError.SqlError> =>
    keys.length === 0
      ? Effect.succeed({ sources: new Set<string>(), approved: new Set<string>() })
      : sql<{ readonly kind: string; readonly value: string }>`
          SELECT kind, value FROM personal_sensitive_exposures
          WHERE ${sql.in("exposure_key", keys)}
        `.pipe(
          Effect.map((rows) => {
            const sources = new Set<string>();
            const approved = new Set<string>();
            for (const row of rows) {
              (row.kind === "source" ? sources : approved).add(row.value);
            }
            return { sources, approved };
          }),
        );

  /**
   * Carries the sensitive sources under `fromKeys` to `toKey`, for content
   * that moves between contexts. Approvals do not travel: the owner allowed a
   * destination for one context, not for every context the content reaches.
   */
  const copySources = (
    fromKeys: ReadonlyArray<string>,
    toKey: string,
  ): Effect.Effect<void, SqlError.SqlError> =>
    Effect.gen(function* () {
      const { sources } = yield* read(fromKeys);
      for (const source of sources) yield* record([toKey], "source", source);
    });

  return { record, read, copySources };
};

export type SensitiveExposureStore = ReturnType<typeof makeSensitiveExposureStore>;
