/**
 * PersonalProjectionRelations over the v2 projection tables.
 *
 * Each relation is a derived table with the column names the personal SQL
 * already reads, so a statement changes only its table token. SQLite flattens
 * every fragment into the outer query. The strings come from code, never from
 * input.
 *
 * @module personal/engine/PersonalProjectionRelationsV2Live
 */
import * as Layer from "effect/Layer";

import {
  PersonalProjectionRelations,
  type PersonalProjectionRelationsShape,
} from "./PersonalProjectionRelations.ts";

const WORKING_RUN_STATUSES = "'preparing', 'starting', 'running', 'waiting'";

export const PERSONAL_V2_RELATIONS: PersonalProjectionRelationsShape = {
  threads: `(
    SELECT t.thread_id AS thread_id,
      t.title AS title,
      t.created_at AS created_at,
      t.updated_at AS updated_at,
      t.archived_at AS archived_at,
      t.deleted_at AS deleted_at,
      json_extract(t.payload_json, '$.pinnedAt') AS pinned_at,
      json_extract(t.payload_json, '$.settledOverride') AS settled_override,
      (
        SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
        WHERE q.thread_id = t.thread_id AND q.status = 'pending' AND q.kind <> 'user_input'
      ) AS pending_approval_count,
      (
        SELECT count(*) FROM orchestration_v2_projection_runtime_requests q
        WHERE q.thread_id = t.thread_id AND q.status = 'pending' AND q.kind = 'user_input'
      ) AS pending_user_input_count
    FROM orchestration_v2_projection_threads t
  )`,
  messages: `(
    SELECT m.message_id AS message_id,
      m.thread_id AS thread_id,
      m.role AS role,
      json_extract(m.payload_json, '$.text') AS text,
      json_extract(m.payload_json, '$.context') AS context_json,
      json_extract(m.payload_json, '$.attachments') AS attachments_json,
      m.streaming AS is_streaming,
      m.created_at AS created_at,
      m.updated_at AS updated_at
    FROM orchestration_v2_projection_messages m
  )`,
  sessions: `(
    SELECT t.thread_id AS thread_id,
      CASE
        WHEN r.status IN ('preparing', 'starting') THEN 'starting'
        WHEN r.status IN ('running', 'waiting') THEN 'running'
        ELSE 'idle'
      END AS status,
      r.run_id AS active_turn_id,
      COALESCE(
        (
          SELECT l.provider_instance_id FROM orchestration_v2_projection_runs l
          WHERE l.thread_id = t.thread_id
          ORDER BY l.ordinal DESC
          LIMIT 1
        ),
        t.provider_instance_id
      ) AS provider_instance_id
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
      SELECT w.run_id FROM orchestration_v2_projection_runs w
      WHERE w.thread_id = t.thread_id AND w.status IN (${WORKING_RUN_STATUSES})
      ORDER BY w.ordinal DESC
      LIMIT 1
    )
  )`,
  turns: `(
    SELECT r.run_id AS turn_id,
      r.thread_id AS thread_id,
      r.requested_at AS requested_at,
      json_extract(r.payload_json, '$.userMessageId') AS pending_message_id
    FROM orchestration_v2_projection_runs r
  )`,
  providerSessions: `(
    SELECT p.thread_id AS thread_id,
      COALESCE(p.driver, p.provider) AS provider_name,
      json_object(
        'resume', json_extract(p.payload_json, '$.nativeThreadRef.nativeId'),
        'threadId', json_extract(p.payload_json, '$.nativeThreadRef.nativeId'),
        'sessionId', json_extract(p.payload_json, '$.nativeThreadRef.nativeId')
      ) AS resume_cursor_json
    FROM orchestration_v2_projection_provider_threads p
    WHERE p.thread_id IS NOT NULL
      AND p.provider_thread_id = (
        SELECT n.provider_thread_id FROM orchestration_v2_projection_provider_threads n
        WHERE n.thread_id = p.thread_id
        ORDER BY n.last_run_ordinal DESC, n.updated_at DESC
        LIMIT 1
      )
  )`,
};

export const PersonalProjectionRelationsV2Live = Layer.succeed(
  PersonalProjectionRelations,
  PERSONAL_V2_RELATIONS,
);
