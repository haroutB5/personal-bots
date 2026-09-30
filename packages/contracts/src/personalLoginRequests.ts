import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalTaskId } from "./personalTasks.ts";

/** Request history is metadata only. Credentials exist solely in the submit RPC. */
export const PersonalLoginRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  taskId: PersonalTaskId,
  threadId: ThreadId,
  botId: PersonalBotId,
  origin: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  reason: Schema.String,
  tabId: TrimmedNonEmptyString,
  status: Schema.Literals([
    "pending",
    "filling",
    "filled",
    "cancelled",
    "expired",
    "origin-mismatch",
    "fill-failed",
  ]),
  saved: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type PersonalLoginRequest = typeof PersonalLoginRequest.Type;

export const PersonalLoginRequestsListInput = Schema.Struct({ threadId: ThreadId });
export const PersonalLoginRequestsListResult = Schema.Struct({
  requests: Schema.Array(PersonalLoginRequest),
});
export const PersonalLoginRequestsSubmitInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  username: Schema.Redacted(Schema.String),
  password: Schema.Redacted(Schema.String),
  save: Schema.optional(Schema.Boolean),
});
export type PersonalLoginRequestsSubmitInput = typeof PersonalLoginRequestsSubmitInput.Type;
export const PersonalLoginRequestsCancelInput = Schema.Struct({ requestId: TrimmedNonEmptyString });
