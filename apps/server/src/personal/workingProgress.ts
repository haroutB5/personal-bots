import { pickProgressNote, toolStepNoteText, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The latest progress note of each chat whose bot is working, for the Bots
 * list rows (an open chat derives the same note from its own thread). One row
 * per running thread:
 *
 * - the newest thinking / reasoning message written since the owner's latest
 *   message (the running turn), first 400 characters;
 * - the newest tool step's TITLE since then (`payload.title`, else the
 *   summary), never its detail, arguments or output.
 *
 * `pickProgressNote` (shared with the client) picks the newer, trims it to one
 * line and blanks secret-looking runs. A thread whose session is not running
 * has no row, so a note never outlives its turn.
 */
export const personalWorkingProgress = (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId>,
) =>
  Effect.gen(function* () {
    if (threadIds.length === 0) return [];
    const rows = yield* sql<{
      readonly threadId: string;
      readonly reasoningText: string | null;
      readonly reasoningAt: string | null;
      readonly toolTitle: string | null;
      readonly toolSummary: string | null;
      readonly toolAt: string | null;
    }>`
      SELECT
        p.thread_id AS "threadId",
        (
          SELECT substr(m.text, 1, 400) FROM projection_thread_messages m
          WHERE m.thread_id = p.thread_id AND m.role = 'reasoning'
            AND m.created_at >= COALESCE(p.latest_user_message_at, '')
          ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
        ) AS "reasoningText",
        (
          SELECT m.updated_at FROM projection_thread_messages m
          WHERE m.thread_id = p.thread_id AND m.role = 'reasoning'
            AND m.created_at >= COALESCE(p.latest_user_message_at, '')
          ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
        ) AS "reasoningAt",
        (
          SELECT NULLIF(json_extract(a.payload_json, '$.title'), '')
          FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= COALESCE(p.latest_user_message_at, '')
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolTitle",
        (
          SELECT a.summary FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= COALESCE(p.latest_user_message_at, '')
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolSummary",
        (
          SELECT a.created_at FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= COALESCE(p.latest_user_message_at, '')
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolAt"
      FROM projection_threads p
      JOIN projection_thread_sessions s ON s.thread_id = p.thread_id
      WHERE ${sql.in("p.thread_id", threadIds)}
        AND p.deleted_at IS NULL
        AND s.status IN ('running', 'starting')
    `;
    const notes: Array<{ readonly threadId: ThreadId; readonly note: string }> = [];
    for (const row of rows) {
      const toolText = toolStepNoteText(row.toolTitle, row.toolSummary);
      const note = pickProgressNote({
        reasoning:
          row.reasoningText === null
            ? null
            : { text: row.reasoningText, at: row.reasoningAt ?? "" },
        tool: toolText === null ? null : { text: toolText, at: row.toolAt ?? "" },
      });
      if (note !== null) notes.push({ threadId: row.threadId as ThreadId, note });
    }
    return notes;
  });
