import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Any refusal or failure of a connection tool, worded for the model. */
export class ConnectionsToolError extends Schema.TaggedError<ConnectionsToolError>()(
  "ConnectionsToolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const ConnectionsToolFailure = Schema.Union([
  McpCapabilityUnavailableError,
  ConnectionsToolError,
]);

export const ListConnectionsResult = Schema.Struct({
  connections: Schema.Array(
    Schema.Struct({
      vendor: Schema.String,
      displayName: Schema.String,
      operations: Schema.Array(
        Schema.Struct({
          operation: Schema.String,
          description: Schema.String,
          /** JSON Schema text; the server validates against the same schema. */
          argumentsJsonSchema: Schema.String,
        }),
      ),
    }),
  ),
});
export type ListConnectionsResult = typeof ListConnectionsResult.Type;

export const ConnectionCallInput = Schema.Struct({
  operation: TrimmedNonEmptyString.annotate({
    description:
      "Exact operation name from list_connections, e.g. 'github.create_repository'. Nothing else runs.",
  }),
  arguments: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      "Arguments exactly as the operation's schema describes them. Extra or missing fields are refused.",
  }),
});
export type ConnectionCallInput = typeof ConnectionCallInput.Type;

export const ConnectionCallResult = Schema.Struct({
  status: Schema.Literals(["completed", "awaiting_approval"]),
  operation: Schema.String,
  /** Only the fields this operation was reviewed to return; null while waiting. */
  result: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  approvalId: Schema.NullOr(Schema.String),
  /** The server's own description of the action, as the user is reading it. */
  summary: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});
export type ConnectionCallResult = typeof ConnectionCallResult.Type;

const ListConnectionsTool = Tool.make("list_connections", {
  description:
    "List the services the user has connected (GitHub, Vercel, Neon, Upstash) and exactly which operations you may ask for, with their argument schemas. Only connected services appear. You cannot connect, switch or change a connection yourself; only the user can, in Settings.",
  success: ListConnectionsResult,
  failure: ConnectionsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List connected services")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ConnectionCallTool = Tool.make("connection_call", {
  description:
    "Run one reviewed operation against a connected service. The server validates your arguments, decides from them whether the user must approve, holds the credential itself and returns only reviewed fields; you never see or handle a token. Anything that writes, deploys, publishes, runs SQL or runs a Redis command waits for the user: you get status 'awaiting_approval', you say in one sentence what you want to do, and you end your turn. You are resumed automatically when they answer. Do not retry a declined action or work around it.",
  parameters: ConnectionCallInput,
  success: ConnectionCallResult,
  failure: ConnectionsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Call a connected service")
  .annotate(Tool.Readonly, false)
  // The gate, not this flag, is what stops a destructive call; the flag only
  // tells a client that one of these can change the user's account.
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ConnectionsToolkit = Toolkit.make(ListConnectionsTool, ConnectionCallTool);
