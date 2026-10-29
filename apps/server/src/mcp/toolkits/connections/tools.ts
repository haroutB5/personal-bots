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
      "Exact operation name from list_connections, e.g. 'github.create_repository'; nothing else runs.",
  }),
  arguments: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      "Arguments exactly as the operation's schema; extra or missing fields are refused.",
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

export const CreateAppInput = Schema.Struct({
  appName: TrimmedNonEmptyString.annotate({
    description:
      "App name, used for the GitHub repository and Vercel project: letters, digits, dot, dash, underscore only.",
  }),
  visibility: Schema.Literals(["private", "public"]).annotate({
    description: "Whether anyone can read the GitHub repository. Ask the user; never choose.",
  }),
  deploymentTarget: Schema.Literals(["preview", "production"]).annotate({
    description: "Environment to deploy. No default: ask the user.",
  }),
  storage: Schema.optional(
    Schema.Array(Schema.Literals(["postgres", "redis"])).annotate({
      description:
        "Databases needed. 'postgres' is Neon (records); 'redis' is Upstash (short-lived cache). Each is a real free-tier resource in the user's account, so ask the user rather than guess; omit if the app stores nothing. Connection details go into the app's environment, never to you.",
    }),
  ),
});
export type CreateAppInput = typeof CreateAppInput.Type;

export const CreateAppStepView = Schema.Struct({
  step: Schema.String,
  title: Schema.String,
  state: Schema.String,
  /** What the provider called whatever this step made. Never a credential. */
  remoteId: Schema.NullOr(Schema.String),
  adopted: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export const CreateAppResult = Schema.Struct({
  status: Schema.Literals([
    "awaiting_approval",
    "running",
    "completed",
    "needs_attention",
    "declined",
  ]),
  runId: Schema.String,
  /** The server's own description of the plan, as the user is reading it. */
  summary: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  /** Set only once a URL answered as the app itself. */
  appUrl: Schema.NullOr(Schema.String),
  steps: Schema.Array(CreateAppStepView),
});
export type CreateAppResult = typeof CreateAppResult.Type;

export const CreateAppStatusInput = Schema.Struct({
  runId: TrimmedNonEmptyString.annotate({ description: "The run id create_app returned." }),
});
export type CreateAppStatusInput = typeof CreateAppStatusInput.Type;

const CreateAppTool = Tool.make("create_app", {
  description:
    "Build a new web app from a pinned template and deploy it: GitHub repository, first commit, Vercel project, environment variables, deployment, and a check that the URL answers. The server writes one plan and the user approves it once: you get status 'awaiting_approval', say in one sentence what you will build, and end your turn. You are resumed when they answer and the run then needs no more questions. Call again with the same arguments to continue (the same plan is never approved twice); changing any argument is a new plan needing new approval.",
  parameters: CreateAppInput,
  success: CreateAppResult,
  failure: ConnectionsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create and deploy an app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  // Calling it again with the same arguments continues one run rather than
  // starting a second; the plan's hash is what makes that true.
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CreateAppStatusTool = Tool.make("create_app_status", {
  description:
    "Read how far a create_app run got: steps done, what each created, and the app URL once live. Use it to report what exists after a run stopped part-way. Do not poll: you are resumed when the run ends.",
  parameters: CreateAppStatusInput,
  success: CreateAppResult,
  failure: ConnectionsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Check an app build")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListConnectionsTool = Tool.make("list_connections", {
  description:
    "List connected services (GitHub, Vercel, Neon, Upstash) and the operations you may ask for, with argument schemas. Only the user can connect or change a connection, in Settings.",
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
    "Run one reviewed operation on a connected service. The server holds the credential and returns only reviewed fields; you never see or handle a token. Anything that writes, deploys, publishes, or runs SQL or Redis commands needs user approval: you get status 'awaiting_approval', say in one sentence what you want to do, and end your turn. You are resumed when they answer. Do not retry a declined action or work around it.",
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

export const ConnectionsToolkit = Toolkit.make(
  ListConnectionsTool,
  ConnectionCallTool,
  CreateAppTool,
  CreateAppStatusTool,
);
