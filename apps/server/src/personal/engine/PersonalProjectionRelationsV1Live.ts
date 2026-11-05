/**
 * PersonalProjectionRelations on the v1 projection tables.
 *
 * The bare v1 names keep every personal query byte-identical to the SQL it
 * replaced, so the relation port changes no plan and no cost.
 *
 * @module personal/engine/PersonalProjectionRelationsV1Live
 */
import * as Layer from "effect/Layer";

import {
  PersonalProjectionRelations,
  type PersonalProjectionRelationsShape,
} from "./PersonalProjectionRelations.ts";

export const PERSONAL_V1_RELATIONS: PersonalProjectionRelationsShape = {
  threads: "projection_threads",
  messages: "projection_thread_messages",
  sessions: "projection_thread_sessions",
  turns: "projection_turns",
  providerSessions: "provider_session_runtime",
};

export const PersonalProjectionRelationsV1Live = Layer.succeed(
  PersonalProjectionRelations,
  PERSONAL_V1_RELATIONS,
);
