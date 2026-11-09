import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import {
  EVENT_LOG_PRUNE_MARK,
  EVENT_LOG_PRUNED_THROUGH,
} from "../persistence/OrchestrationEventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  /** Deletes events the projections already cover once they are older than the retained history. */
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly reclaimableBytes: number;
      /** True when every phase reached its fixed bound, so the pass may be recorded as complete. */
      readonly drained: boolean;
    },
    ProjectionMaintenanceError
  >;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

// Reconnect replay and command-id retries read this tail; older cursors resync from a snapshot.
const RETAINED_EVENT_HISTORY = Duration.days(1);
// Small pages bound work on the reader worker and synchronous fallback.
const PAGE_SIZE = 50;
// A 50-row delete held the writer 1.5 to 2.2 s on the restored real copy. Bound
// each delete to a handful of rows and yield, so no statement stalls the loop.
const DELETE_BATCH_SIZE = 5;
const REFERENCE_SCAN_WINDOW = 1000;
// A pass records the last page it finished, so a restart resumes there instead of
// rescanning the event store. The rows are cleared when a pass drains.
const COMPACTION_EVENTS_CURSOR = "event-log-compaction-events-cursor";
const COMPACTION_LEGACY_EVENTS_CURSOR = "event-log-compaction-legacy-events-cursor";
const COMPACTION_RECEIPTS_CURSOR = "event-log-compaction-receipts-cursor";
const COMPACTION_CURSORS = [
  COMPACTION_EVENTS_CURSOR,
  COMPACTION_LEGACY_EVENTS_CURSOR,
  COMPACTION_RECEIPTS_CURSOR,
] as const;
// A checkpoint or another process can hold the writer for longer than one
// statement waits. Retry the batch with backoff; the cursor makes it safe.
const LOCK_RETRY_LIMIT = 8;
const LOCK_RETRY_BASE = Duration.millis(100);

const isLockTimeout = (cause: unknown): boolean =>
  SqlError.isSqlError(cause) && cause.reason._tag === "LockTimeoutError";

const retryLockTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isLockTimeout,
      schedule: Schedule.exponential(LOCK_RETRY_BASE).pipe(
        Schedule.jittered,
        Schedule.upTo({ times: LOCK_RETRY_LIMIT }),
      ),
    }),
  );

type MetadataRow = {
  readonly projection_name: string;
  readonly last_sequence: number;
  readonly updated_at: string;
};

export const layer: Layer.Layer<ProjectionMaintenanceV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const writeMetadata = (name: string, sequence: number, at: DateTime.Utc) =>
      retryLockTimeout(sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        )
        VALUES (
          ${name},
          ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
          ${sequence},
          ${DateTime.formatIso(at)}
        )
        ON CONFLICT(projection_name) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          updated_at = excluded.updated_at
      `);

    const readProgress = Effect.fnUntraced(function* () {
      const rows = yield* sql<{
        readonly projection_name: string;
        readonly last_sequence: number;
      }>`
        SELECT projection_name, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name IN ${sql.in([...COMPACTION_CURSORS])}
      `.pipe(NodeSqliteClient.readOnly);
      const read = (name: string) =>
        rows.find((row) => row.projection_name === name)?.last_sequence ?? 0;
      return {
        events: read(COMPACTION_EVENTS_CURSOR),
        legacyEvents: read(COMPACTION_LEGACY_EVENTS_CURSOR),
        receipts: read(COMPACTION_RECEIPTS_CURSOR),
      };
    });

    const clearProgress = retryLockTimeout(sql`
      DELETE FROM orchestration_v2_projection_metadata
      WHERE projection_name IN ${sql.in([...COMPACTION_CURSORS])}
    `);

    // Collects anchors whose prompt later rows borrow through promptSequence.
    const readPromptReferences = Effect.fnUntraced(function* (
      afterSequence: number,
      throughSequence: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = new Set<number>();
      for (let cursor = afterSequence; cursor < throughSequence;) {
        const windowEnd = Math.min(cursor + REFERENCE_SCAN_WINDOW, throughSequence);
        const rows = yield* sql<{ readonly prompt_sequence: number }>`
          SELECT json_extract(payload_json, '$.promptSequence') AS prompt_sequence
          FROM orchestration_events
          WHERE sequence > ${cursor}
            AND sequence <= ${windowEnd}
            AND event_type IN ('subagent.updated', 'turn-item.updated')
            AND json_type(payload_json, '$.promptSequence') = 'integer'
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of rows) referenced.add(row.prompt_sequence);
        cursor = windowEnd;
        yield* betweenPages;
      }
      return referenced;
    });

    const pruneEvents = Effect.fnUntraced(function* (
      throughSequence: number,
      head: number,
      fromSequence: number,
      betweenPages: Effect.Effect<void>,
      now: DateTime.Utc,
    ) {
      const referenced = yield* readPromptReferences(throughSequence, head, betweenPages);
      // Stream heads at or below the boundary are kept, so the anchors they borrow must stay too.
      const keptHeadReferences = yield* sql<{ readonly prompt_sequence: number }>`
        SELECT json_extract(event.payload_json, '$.promptSequence') AS prompt_sequence
        FROM (
          SELECT MAX(sequence) AS sequence FROM orchestration_events
          GROUP BY aggregate_kind, stream_id
        ) AS heads
        JOIN orchestration_events AS event ON event.sequence = heads.sequence
        WHERE heads.sequence <= ${throughSequence}
          AND event.event_type IN ('subagent.updated', 'turn-item.updated')
          AND json_type(event.payload_json, '$.promptSequence') = 'integer'
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of keptHeadReferences) referenced.add(row.prompt_sequence);
      yield* betweenPages;
      let referencesThrough = head;
      let deleted = 0;
      let cursor = fromSequence;
      while (cursor < throughSequence) {
        const rows = yield* sql<{ readonly sequence: number; readonly prunable: number }>`
          SELECT
            event.sequence,
            CASE
              WHEN event.application_event_version = 1 THEN 0
              -- The legacy importer treats a thread without thread.created as not yet imported.
              WHEN event.event_type = 'thread.created' THEN 0
              -- Codex usage history reads the selection a run attempt started with.
              WHEN event.event_type = 'run.updated'
                AND json_extract(event.payload_json, '$.status') = 'running' THEN 0
              -- The newest row keeps each stream's high water, stream_version, and snapshot sequence.
              WHEN event.sequence = (
                SELECT MAX(newer.sequence) FROM orchestration_events AS newer
                WHERE newer.aggregate_kind = event.aggregate_kind
                  AND newer.stream_id = event.stream_id
              ) THEN 0
              ELSE 1
            END AS prunable
          FROM orchestration_events AS event
          WHERE event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const candidates = rows.filter((row) => row.prunable === 1).map((row) => row.sequence);
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        for (let offset = 0; offset < candidates.length; offset += DELETE_BATCH_SIZE) {
          const batch = candidates.slice(offset, offset + DELETE_BATCH_SIZE);
          deleted += yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Rows appended since the reference scan may borrow a prompt from a candidate.
                const appended = yield* sql<{
                  readonly sequence: number;
                  readonly prompt_sequence: number | null;
                }>`
                SELECT
                  sequence,
                  CASE
                    WHEN event_type IN ('subagent.updated', 'turn-item.updated')
                      AND json_type(payload_json, '$.promptSequence') = 'integer'
                    THEN json_extract(payload_json, '$.promptSequence')
                  END AS prompt_sequence
                FROM orchestration_events
                WHERE sequence > ${referencesThrough}
              `;
                for (const row of appended) {
                  if (row.prompt_sequence !== null) referenced.add(row.prompt_sequence);
                  referencesThrough = Math.max(referencesThrough, row.sequence);
                }
                const obsolete = batch.filter((sequence) => !referenced.has(sequence));
                if (obsolete.length === 0) return 0;
                yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
                return obsolete.length;
              }),
            )
            .pipe(retryLockTimeout);
          yield* Effect.yieldNow;
        }
        const pageEnd = rows.length < PAGE_SIZE ? throughSequence : rows.at(-1)!.sequence;
        yield* writeMetadata(COMPACTION_EVENTS_CURSOR, pageEnd, now);
        // Rest after every page, including the last, so the next loop starts a fresh slice.
        yield* betweenPages;
        cursor = pageEnd;
        if (rows.length < PAGE_SIZE) break;
      }
      return { deleted, cursor };
    });

    // Imported legacy threads are served from v2 rows; their v1 events and receipts have no reader.
    const pruneImportedLegacyHistory = Effect.fnUntraced(function* (
      throughSequence: number,
      throughReceiptRowId: number,
      fromEvents: number,
      fromReceipts: number,
      betweenPages: Effect.Effect<void>,
      now: DateTime.Utc,
    ) {
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;
      let eventsCursor = fromEvents;
      for (let cursor = fromEvents; ;) {
        const rows = yield* sql<{ readonly sequence: number; readonly imported: number }>`
          SELECT
            event.sequence,
            event.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = event.stream_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_events AS event
            INDEXED BY idx_orchestration_events_application_sequence
          WHERE event.application_event_version = 1
            AND event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.sequence);
        yield* Effect.yieldNow;
        for (let offset = 0; offset < obsolete.length; offset += DELETE_BATCH_SIZE) {
          const batch = obsolete.slice(offset, offset + DELETE_BATCH_SIZE);
          yield* retryLockTimeout(
            sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(batch)}`,
          );
          deletedEventCount += batch.length;
          yield* Effect.yieldNow;
        }
        const pageEnd = rows.length < PAGE_SIZE ? throughSequence : rows.at(-1)!.sequence;
        yield* writeMetadata(COMPACTION_LEGACY_EVENTS_CURSOR, pageEnd, now);
        eventsCursor = pageEnd;
        yield* betweenPages;
        cursor = pageEnd;
        if (rows.length < PAGE_SIZE) break;
      }
      let receiptsCursor = fromReceipts;
      for (let cursor = fromReceipts; ;) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = receipt.aggregate_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid > ${cursor} AND receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.command_id);
        yield* Effect.yieldNow;
        for (let offset = 0; offset < obsolete.length; offset += DELETE_BATCH_SIZE) {
          const batch = obsolete.slice(offset, offset + DELETE_BATCH_SIZE);
          yield* retryLockTimeout(
            sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(batch)}`,
          );
          deletedReceiptCount += batch.length;
          yield* Effect.yieldNow;
        }
        const pageEnd = rows.length < PAGE_SIZE ? throughReceiptRowId : rows.at(-1)!.row_id;
        yield* writeMetadata(COMPACTION_RECEIPTS_CURSOR, pageEnd, now);
        receiptsCursor = pageEnd;
        yield* betweenPages;
        cursor = pageEnd;
        if (rows.length < PAGE_SIZE) break;
      }
      return { deletedEventCount, deletedReceiptCount, eventsCursor, receiptsCursor };
    });

    // A pass prunes through the mark the previous pass left once that mark is a day old, so
    // at least RETAINED_EVENT_HISTORY of events always remains. Receipts stay for idempotency.
    const pruneEventStore = Effect.fn("ProjectionMaintenance.pruneEventStore")(
      function* (betweenPages: Effect.Effect<void> = Effect.void) {
        const now = yield* DateTime.now;
        const metadata = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name IN (
            'thread-projections', ${EVENT_LOG_PRUNE_MARK}, ${EVENT_LOG_PRUNED_THROUGH}
          )
        `.pipe(NodeSqliteClient.readOnly);
        const read = (name: string) => metadata.find((row) => row.projection_name === name);
        const projected = read("thread-projections")?.last_sequence ?? 0;
        const mark = read(EVENT_LOG_PRUNE_MARK);
        const prunedThrough = read(EVENT_LOG_PRUNED_THROUGH)?.last_sequence ?? 0;
        // Fixed bounds: foreground commits during the pass wait for the next one.
        const bounds = yield* sql<{ readonly sequence: number; readonly receipt_row_id: number }>`
          SELECT
            COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS sequence,
            COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
        `.pipe(NodeSqliteClient.readOnly);
        const head = bounds[0]?.sequence ?? 0;
        const receiptRowId = bounds[0]?.receipt_row_id ?? 0;
        const progress = yield* readProgress();

        let deletedEventCount = 0;
        const markIsDue =
          mark !== undefined &&
          DateTime.toEpochMillis(now) - Date.parse(mark.updated_at) >=
            Duration.toMillis(RETAINED_EVENT_HISTORY);
        const eventsBoundary =
          mark !== undefined && markIsDue
            ? Math.max(Math.min(mark.last_sequence, projected), prunedThrough)
            : 0;
        let eventsCursor = progress.events;
        if (mark !== undefined && markIsDue) {
          if (eventsBoundary > prunedThrough) {
            // Publish the boundary first so resuming clients take a snapshot, never a partial replay.
            yield* writeMetadata(EVENT_LOG_PRUNED_THROUGH, eventsBoundary, now);
          }
          const pruned = yield* pruneEvents(
            eventsBoundary,
            head,
            progress.events,
            betweenPages,
            now,
          );
          deletedEventCount += pruned.deleted;
          eventsCursor = pruned.cursor;
        }
        if (mark === undefined || markIsDue) yield* writeMetadata(EVENT_LOG_PRUNE_MARK, head, now);

        const legacy = yield* pruneImportedLegacyHistory(
          head,
          receiptRowId,
          progress.legacyEvents,
          progress.receipts,
          betweenPages,
          now,
        );
        deletedEventCount += legacy.deletedEventCount;

        const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        const reclaimableBytes =
          (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

        // A pass that stopped early keeps its cursors; the next boot resumes from them.
        const drained =
          eventsCursor >= eventsBoundary &&
          legacy.eventsCursor >= head &&
          legacy.receiptsCursor >= receiptRowId;
        if (drained) yield* clearProgress;

        return {
          deletedEventCount,
          deletedReceiptCount: legacy.deletedReceiptCount,
          reclaimableBytes,
          drained,
        };
      },
      Effect.mapError(
        (cause) => new ProjectionMaintenanceError({ operation: "prune event store", cause }),
      ),
    );

    return ProjectionMaintenanceV2.of({ pruneEventStore });
  }),
);
