/**
 * Upstream T3 Code migrations re-registered at our ids.
 *
 * This fork added 052-066 before upstream added its own 052. The migrator only
 * runs ids above the latest applied one, so an upstream migration keeps its
 * file name (clean future merges) but is registered in Migrations.ts at our
 * next free id. Key: upstream file name without ".ts". Value: our id.
 *
 * scripts/personal/sync/resolve-migrations.ts appends to this map during the
 * weekly upstream sync; Migrations.registry.test.ts enforces it.
 */
export const UPSTREAM_MIGRATION_IDS: Readonly<Record<string, number>> = {
  "052_ProjectionThreadTitleState": 67,
  "053_PullRequestFilesViewed": 82,
  "054_ProjectionThreadsAutoSettleDisabledAt": 83,
};
