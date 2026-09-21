import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalConnectionApprovalId, PersonalConnectionVendorId } from "./personalConnections.ts";
import { PersonalTaskId } from "./personalTasks.ts";

/**
 * `create_app`: one approved plan, executed step by step, resumable.
 *
 * The plan is the unit of consent. The owner reads one card describing every
 * account, name, target and cost the run may touch, and execution then runs
 * without asking again — but *only* within that plan. Anything outside it is a
 * material change and a fresh decision, which is why the plan is immutable
 * once approved and is identified by a hash of itself.
 *
 * Nothing here ever carries a credential or an environment variable *value*.
 * Keys are named so the owner can read what will be set; values live in the
 * server's own memory for the length of a step and reach the vendor directly.
 */

export const CreateAppRunId = TrimmedNonEmptyString.pipe(Schema.brand("CreateAppRunId"));
export type CreateAppRunId = typeof CreateAppRunId.Type;

/**
 * Preview and production are never inferred from each other, here or anywhere
 * downstream. The owner approves a target by reading its name.
 */
export const CreateAppDeploymentTarget = Schema.Literals(["preview", "production"]);
export type CreateAppDeploymentTarget = typeof CreateAppDeploymentTarget.Type;

export const CreateAppRepositoryVisibility = Schema.Literals(["private", "public"]);
export type CreateAppRepositoryVisibility = typeof CreateAppRepositoryVisibility.Type;

/**
 * A data store the run will provision, and the seam Milestone 4's vendors plug
 * into. It is part of the plan rather than a runtime decision because a store
 * is the one part of `create_app` that costs money: its tier, region and
 * ceiling are read by the owner on the card, and the operations it declares
 * are the only ones the plan authorizes for it.
 */
export const CreateAppDataStorePlan = Schema.Struct({
  /** Stable across resume, so a persisted step row keeps its meaning. */
  stepId: TrimmedNonEmptyString,
  vendorId: PersonalConnectionVendorId,
  title: TrimmedNonEmptyString,
  resourceName: TrimmedNonEmptyString,
  region: TrimmedNonEmptyString,
  tier: TrimmedNonEmptyString,
  /** Owner-readable spend bound, e.g. "free tier only, no paid usage". */
  costCeiling: TrimmedNonEmptyString,
  /** Gateway operations this store's step may call. Nothing else is covered. */
  operationIds: Schema.Array(TrimmedNonEmptyString),
  /** Everything the step will touch, in the gateway's resource vocabulary. */
  targetResources: Schema.Array(Schema.String),
  /** Environment variable names this store will fill. Never their values. */
  environmentKeys: Schema.Array(TrimmedNonEmptyString),
});
export type CreateAppDataStorePlan = typeof CreateAppDataStorePlan.Type;

export const CreateAppPlan = Schema.Struct({
  appName: TrimmedNonEmptyString,
  /** The known-good scaffold, pinned by revision and by a hash of its contents. */
  template: Schema.Struct({
    revision: TrimmedNonEmptyString,
    digest: TrimmedNonEmptyString,
  }),
  github: Schema.Struct({
    /** The account the token was validated against, as the owner saw it. */
    account: TrimmedNonEmptyString,
    /** owner/name, resolved at plan time so nothing is guessed at push time. */
    repository: TrimmedNonEmptyString,
    repositoryName: TrimmedNonEmptyString,
    visibility: CreateAppRepositoryVisibility,
    branch: TrimmedNonEmptyString,
  }),
  vercel: Schema.Struct({
    account: TrimmedNonEmptyString,
    teamName: Schema.NullOr(Schema.String),
    project: TrimmedNonEmptyString,
    framework: Schema.NullOr(TrimmedNonEmptyString),
  }),
  deployment: Schema.Struct({
    target: CreateAppDeploymentTarget,
    /** Which environments get variables. Named separately from the deploy target. */
    environmentTargets: Schema.Array(CreateAppDeploymentTarget),
  }),
  /** Every variable name any step may set. Values are never part of a plan. */
  environmentKeys: Schema.Array(TrimmedNonEmptyString),
  dataStores: Schema.Array(CreateAppDataStorePlan),
  costCeiling: TrimmedNonEmptyString,
  /**
   * What "it works" means. A marker the pinned template is known to serve, so
   * completion is a URL that answered with this app rather than a 200 from a
   * deployment API or a provider's own holding page.
   */
  healthCheck: Schema.Struct({
    path: TrimmedNonEmptyString,
    marker: TrimmedNonEmptyString,
  }),
});
export type CreateAppPlan = typeof CreateAppPlan.Type;

/**
 * `in_flight` is the state that makes this durable: it means the provider was
 * asked and we do not know what it did. A step in that state is reconciled
 * against what exists before anything is sent again.
 */
export const CreateAppStepState = Schema.Literals([
  "pending",
  "in_flight",
  "done",
  "failed",
  "skipped",
]);
export type CreateAppStepState = typeof CreateAppStepState.Type;

export const CreateAppStep = Schema.Struct({
  stepId: TrimmedNonEmptyString,
  /** Server-authored, so what the owner reads is never the model's words. */
  title: TrimmedNonEmptyString,
  position: Schema.Int,
  state: CreateAppStepState,
  /** How many times this step has been started, including reconciled resumes. */
  attempts: Schema.Int,
  /** The identity the provider gave whatever this step created. */
  remoteId: Schema.NullOr(Schema.String),
  /** Whether that identity was adopted from a reconcile rather than created here. */
  adopted: Schema.Boolean,
  /** Safe, allowlisted facts about what ran. Never a value, never a credential. */
  receipt: Schema.Record(Schema.String, Schema.String),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type CreateAppStep = typeof CreateAppStep.Type;

/**
 * `needs_attention` is a partial failure that is still a resumable task: the
 * run says what exists and what remains, and nothing is ever deleted to tidy
 * up. Cleaning up what a run created is a separate, separately approved act.
 */
export const CreateAppRunStatus = Schema.Literals([
  "awaiting_approval",
  "running",
  "completed",
  "needs_attention",
  "declined",
]);
export type CreateAppRunStatus = typeof CreateAppRunStatus.Type;

export const CreateAppRun = Schema.Struct({
  runId: CreateAppRunId,
  botId: PersonalBotId,
  threadId: ThreadId,
  taskId: Schema.NullOr(PersonalTaskId),
  plan: CreateAppPlan,
  /** Hash of the approved plan. The approval binds to exactly this. */
  planDigest: TrimmedNonEmptyString,
  approvalId: Schema.NullOr(PersonalConnectionApprovalId),
  status: CreateAppRunStatus,
  /** The health-checked URL. Null until one answered. */
  appUrl: Schema.NullOr(Schema.String),
  steps: Schema.Array(CreateAppStep),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CreateAppRun = typeof CreateAppRun.Type;

export class CreateAppError extends Schema.TaggedError<CreateAppError>()("CreateAppError", {
  message: TrimmedNonEmptyString,
}) {}
