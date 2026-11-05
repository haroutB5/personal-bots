/**
 * The projection relations personal SQL repositories read.
 *
 * Personal queries join the same five relations on v1 and v2. The port hands
 * out relation names, so one statement stays one statement and only the table
 * token changes between implementations. The strings come from code, never
 * from input.
 *
 * @module personal/engine/PersonalProjectionRelations
 */
import * as Context from "effect/Context";

export interface PersonalProjectionRelationsShape {
  /** thread_id, title, created_at, updated_at, archived_at, deleted_at, pinned_at, settled_override, pending_approval_count, pending_user_input_count */
  readonly threads: string;
  /** message_id, thread_id, role, text, context_json, attachments_json, is_streaming, created_at, updated_at */
  readonly messages: string;
  /** thread_id, status, active_turn_id, provider_instance_id. Only 'starting' and 'running' carry meaning. */
  readonly sessions: string;
  /** turn_id, thread_id, requested_at, pending_message_id */
  readonly turns: string;
  /** thread_id, provider_name, resume_cursor_json */
  readonly providerSessions: string;
}

export class PersonalProjectionRelations extends Context.Service<
  PersonalProjectionRelations,
  PersonalProjectionRelationsShape
>()("t3/personal/engine/PersonalProjectionRelations") {}
