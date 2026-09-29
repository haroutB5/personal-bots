import { pickProgressNote, toolStepNoteText, type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The latest progress note of each chat whose bot is working, for the Bots
 * list rows (an open chat derives the same note from its own thread). One row
 * per running thread:
 *
 * - the newest thinking / reasoning message written in the running turn
 *   (since the later of the owner's latest message and the latest turn's
 *   request: a turn the server starts on its own has no owner message), first
 *   400 characters;
 * - the newest tool step's TITLE since then (`payload.title`, else the
 *   summary), never its detail, arguments or output.
 *
 * `pickProgressNote` (shared with the client) picks the newer, trims it to one
 * line and blanks secret-looking runs. Each note carries the id of the turn it
 * was read from (the thread's latest turn, the one its shell reports), so a
 * client holding a note from an earlier turn can tell it is not this turn's. A thread whose session is not running
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
      readonly turnId: string | null;
      readonly reasoningText: string | null;
      readonly reasoningAt: string | null;
      readonly toolTitle: string | null;
      readonly toolSummary: string | null;
      readonly toolAt: string | null;
    }>`
      SELECT
        p.thread_id AS "threadId",
        p.latest_turn_id AS "turnId",
        (
          SELECT substr(m.text, 1, 400) FROM projection_thread_messages m
          WHERE m.thread_id = p.thread_id AND m.role = 'reasoning'
            AND m.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
        ) AS "reasoningText",
        (
          SELECT m.updated_at FROM projection_thread_messages m
          WHERE m.thread_id = p.thread_id AND m.role = 'reasoning'
            AND m.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
        ) AS "reasoningAt",
        (
          SELECT NULLIF(json_extract(a.payload_json, '$.title'), '')
          FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolTitle",
        (
          SELECT a.summary FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolSummary",
        (
          SELECT a.created_at FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolAt"
      FROM projection_threads p
      LEFT JOIN projection_turns t
        ON t.thread_id = p.thread_id AND t.turn_id = p.latest_turn_id
      JOIN projection_thread_sessions s ON s.thread_id = p.thread_id
      WHERE ${sql.in("p.thread_id", threadIds)}
        AND p.deleted_at IS NULL
        AND s.status IN ('running', 'starting')
    `;
    const notes: Array<{
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly note: string;
    }> = [];
    for (const row of rows) {
      const toolText = toolStepNoteText(row.toolTitle, row.toolSummary);
      const note = pickProgressNote({
        reasoning:
          row.reasoningText === null
            ? null
            : { text: row.reasoningText, at: row.reasoningAt ?? "" },
        tool: toolText === null ? null : { text: toolText, at: row.toolAt ?? "" },
      });
      if (note !== null) {
        notes.push({
          threadId: row.threadId as ThreadId,
          turnId: row.turnId === null ? null : (row.turnId as TurnId),
          note,
        });
      }
    }
    return notes;
  });
