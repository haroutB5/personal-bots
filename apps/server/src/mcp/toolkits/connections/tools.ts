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

export const CreateAppInput = Schema.Struct({
  appName: TrimmedNonEmptyString.annotate({
    description:
      "The app's name. Used for the GitHub repository and the Vercel project, so letters, digits, dot, dash and underscore only.",
  }),
  visibility: Schema.Literals(["private", "public"]).annotate({
    description:
      "Whether the GitHub repository is readable by anyone. Ask the user; never choose for them.",
  }),
  deploymentTarget: Schema.Literals(["preview", "production"]).annotate({
    description:
      "Which environment to deploy. There is no default: ask the user which one they mean.",
  }),
  storage: Schema.optional(
    Schema.Array(Schema.Literals(["postgres", "redis"])).annotate({
      description:
        "Databases the app needs, if any. 'postgres' is a Neon database for records the app keeps; 'redis' is an Upstash cache for short-lived values. Each one is created on its free tier and its connection details are put into the app's environment by the server, never shown to you. Omit it for an app that stores nothing; ask the user rather than guessing, because each one is a real resource in their account.",
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
    "Build a new web app from a pinned template and put it live: a GitHub repository, a first commit, a Vercel project, its environment variables, a deployment, and a check that the URL actually answers. The server writes one plan describing every account, name, target and cost, and the user approves it once; you get status 'awaiting_approval', you say in one sentence what you are about to build, and you end your turn. You are resumed automatically when they answer, and the whole run then happens without further questions. Call it again with the same arguments to continue; the same plan is never approved twice. Changing any argument is a different plan and needs a new approval.",
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
    "Read where a create_app run got to: which steps are done, what each one created, and the app's URL once one answered. Use this to tell the user what exists after a run stopped part-way; do not use it to poll, you are resumed when the run ends.",
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

export const ConnectionsToolkit = Toolkit.make(
  ListConnectionsTool,
  ConnectionCallTool,
  CreateAppTool,
  CreateAppStatusTool,
);
