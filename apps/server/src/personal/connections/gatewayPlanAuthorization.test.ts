import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import {
  ConnectionId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  PersonalTaskId,
  ThreadId,
  type CreateAppPlan,
  type PersonalConnectionApproval,
  type PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as Adapters from "./adapters.ts";
import * as ApprovalRepository from "./approvalRepository.ts";
import * as ApprovalService from "./approvalService.ts";
import { buildCreateAppPlan, createAppPlanDigest } from "./createApp/plan.ts";
import { STATIC_APP_TEMPLATE } from "./createApp/template.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as Gateway from "./gateway.ts";
import * as ConnectionService from "./service.ts";

/**
 * The gateway's second authorization path: a decision already taken about a
 * whole plan, rather than a card per call.
 *
 * Every test here is about the boundary of that plan. Inside it, steps run
 * unattended; outside it, nothing runs at all — and in particular no one-off
 * card is raised, because a run that could collect approvals one at a time
 * would drift out of the plan the owner actually read.
 */

const TOKEN = "vercel_fake_TOKEN_value_0123456789";
const DATABASE_URL = "postgres://user:s3cr3t-password@db.example/app";

const text = (value: unknown) =>
  NodeUtil.inspect(value, {
    depth: null,
    breakLength: Infinity,
    maxArrayLength: null,
    maxStringLength: null,
  });

const caller = {
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
};

const plan = (): CreateAppPlan => {
  const built = buildCreateAppPlan({
    appName: "my-app",
    template: STATIC_APP_TEMPLATE,
    githubAccount: "octocat",
    repositoryName: "my-app",
    visibility: "private",
    branch: "main",
    vercelAccount: "octocat",
    vercelTeamName: null,
    projectName: "my-app",
    deploymentTarget: "production",
    environmentTargets: ["production"],
    dataStores: [],
  });
  if (built._tag === "Failure") throw new Error(built.failure);
  return built.success;
};

const approvalFor = (
  input: CreateAppPlan,
  status: PersonalConnectionApproval["status"],
): PersonalConnectionApproval => ({
  approvalId: PersonalConnectionApprovalId.make("approval-plan-1"),
  connectionId: ConnectionId.make("connection-1"),
  vendorId: "vercel",
  operationId: "workflow.create_app",
  actionDigest: createAppPlanDigest(input),
  riskReason: "deployment",
  summary: "Create the app my-app and put it live.",
  targetResources: [],
  credentialVersion: 1,
  threadId: caller.threadId,
  botId: caller.botId,
  taskId: caller.taskId,
  status,
  createdAt: DateTime.makeUnsafe("2026-09-21T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-09-21T00:15:00.000Z"),
  decidedAt: DateTime.makeUnsafe("2026-09-21T00:01:00.000Z"),
  executedAt: null,
  executionOutcome: null,
});

interface HarnessOptions {
  readonly execute?: (
    call: Adapters.ConnectionVendorCall,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, Adapters.ConnectionVendorError>;
}

const makeHarness = (options?: HarnessOptions) => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const calls: Array<Adapters.ConnectionVendorCall> = [];
  const logs: Array<string> = [];

  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    markNeedsReauth: () => Effect.void,
    resolveForOperation: (vendorId: PersonalConnectionVendorId) =>
      Effect.succeed(
        Option.some({
          connectionId: ConnectionId.make("connection-1"),
          vendorId,
          credentialRef: "opaque-1",
          credentialVersion: 1,
          account: null,
        }),
      ),
  });

  const credentials = Layer.succeed(
    CredentialStore.PersonalConnectionCredentialStore,
    CredentialStore.PersonalConnectionCredentialStore.of({
      create: () => Effect.die("unused"),
      createNext: () => Effect.die("unused"),
      read: () => Effect.succeed(Option.some({ accessToken: Redacted.make(TOKEN) })),
      remove: () => Effect.void,
    }),
  );

  const approvalRepository = ApprovalRepository.PersonalConnectionApprovalRepository.of({
    insert: (approval) =>
      Effect.sync(() => {
        approvals.set(approval.approvalId, approval);
      }),
    get: (approvalId) => Effect.sync(() => Option.fromNullishOr(approvals.get(approvalId))),
    listByDigest: (digest) =>
      Effect.sync(() => [...approvals.values()].filter((row) => row.actionDigest === digest)),
    listByStatus: (status) =>
      Effect.sync(() => [...approvals.values()].filter((row) => row.status === status)),
    listPastDue: () => Effect.sync(() => []),
    writeStatus: (input) =>
      Effect.sync(() => {
        const row = approvals.get(input.approvalId);
        if (row === undefined || row.status !== input.expectedStatus) return false;
        approvals.set(input.approvalId, {
          ...row,
          status: input.status,
          decidedAt: input.decidedAt,
        });
        return true;
      }),
    writeReceipt: (input) =>
      Effect.sync(() => {
        const row = approvals.get(input.approvalId);
        if (row === undefined || row.executedAt !== null) return false;
        approvals.set(input.approvalId, {
          ...row,
          executedAt: input.executedAt,
          executionOutcome: input.outcome,
        });
        return true;
      }),
  });

  const parked = Effect.succeed(undefined as unknown as never);
  const tasks = Layer.mock(PersonalTaskService.PersonalTaskService)({
    waitForUser: () => parked,
    resumeFromUser: () => parked,
    failWaitingForUser: () => parked,
  });

  const browser = Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed([]) });

  const adapterFor = (
    vendorId: PersonalConnectionVendorId,
    schemas: Readonly<Record<string, string>>,
    reply: Readonly<Record<string, unknown>>,
  ): Adapters.ConnectionVendorAdapter => ({
    vendorId,
    validate: () => Effect.die("validate is not part of a gateway call"),
    vendorSchema: (operationId) =>
      Option.match(Option.fromNullishOr(schemas[operationId]), {
        onNone: () => Effect.die(`no schema for ${operationId}`),
        onSome: (schema) => Effect.succeed(schema),
      }),
    execute: (call) =>
      Effect.sync(() => {
        calls.push(call);
      }).pipe(Effect.andThen(options?.execute?.(call) ?? Effect.succeed(reply))),
  });

  const layer = Gateway.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        connections,
        credentials,
        browser,
        Adapters.layerOf([
          adapterFor(
            "github",
            {
              "github.create_repository": "github/repos@2026-09-20",
              "github.list_repositories": "github/repos@2026-09-20",
              "github.push_files": "github/git-data@2026-09-20",
            },
            { repository: "octocat/my-app", htmlUrl: "https://github.com/octocat/my-app" },
          ),
          adapterFor(
            "vercel",
            {
              "vercel.create_deployment": "vercel/v13-deployments@2026-09-20",
              "vercel.set_environment_variables": "vercel/v10-project-env@2026-09-20",
            },
            { deploymentId: "dpl_1", url: "https://my-app.example", target: "production" },
          ),
        ]),
        ApprovalService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                ApprovalRepository.PersonalConnectionApprovalRepository,
                approvalRepository,
              ),
              tasks,
            ),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Logger.layer([
        Logger.make(({ message }) => {
          logs.push(text(message));
        }),
      ]),
    ),
  );

  return { layer, approvals, calls, logs };
};

describe("connection gateway: plan authorization", () => {
  it.effect("runs a step the approved plan covers without asking again", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const current = plan();
      const approval = approvalFor(current, "approved");
      harness.approvals.set(approval.approvalId, approval);

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const outcome = yield* gateway.call({
          operation: "github.create_repository",
          arguments: { name: "my-app", visibility: "private" },
          caller,
          planAuthorization: { approvalId: approval.approvalId, plan: current },
        });
        expect(outcome._tag).toBe("completed");
        expect(harness.calls).toHaveLength(1);
        // Creating a repository always needs a card on its own. Under a plan
        // that named it, it does not: that is what one decision buys.
        expect([...harness.approvals.values()].filter((row) => row.status === "pending")).toEqual(
          [],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not spend the plan's decision on a single step", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const current = plan();
      const approval = approvalFor(current, "approved");
      harness.approvals.set(approval.approvalId, approval);

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        yield* gateway.call({
          operation: "github.create_repository",
          arguments: { name: "my-app", visibility: "private" },
          caller,
          planAuthorization: { approvalId: approval.approvalId, plan: current },
        });
        // A per-call approval is single use. A plan is not: it has many steps,
        // and its one receipt is written when the run ends.
        expect(harness.approvals.get(approval.approvalId)?.executedAt).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses the other deployment target outright, and raises no card for it", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const current = plan();
      const approval = approvalFor(current, "approved");
      harness.approvals.set(approval.approvalId, approval);

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(
          gateway.call({
            operation: "vercel.create_deployment",
            // The plan named production. Preview is a different decision.
            arguments: { project: "my-app", target: "preview", gitRef: "main" },
            caller,
            planAuthorization: { approvalId: approval.approvalId, plan: current },
          }),
        );
        expect(error.reason).toContain("vercel:target:preview");
        expect(harness.calls).toEqual([]);
        // Not turned into a one-off card: a run collecting approvals one at a
        // time is a run leaving the plan the owner read.
        expect([...harness.approvals.values()].filter((row) => row.status === "pending")).toEqual(
          [],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses a plan that is not the one the decision was taken about", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const approved = plan();
      const approval = approvalFor(approved, "approved");
      harness.approvals.set(approval.approvalId, approval);
      // The same decision, offered with a plan edited afterwards. The digest
      // is what the approval binds to, so a doctored plan cannot borrow it.
      const doctored: CreateAppPlan = {
        ...approved,
        github: { ...approved.github, visibility: "public" },
      };

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(
          gateway.call({
            operation: "github.create_repository",
            arguments: { name: "my-app", visibility: "public" },
            caller,
            planAuthorization: { approvalId: approval.approvalId, plan: doctored },
          }),
        );
        expect(error.reason).toContain("does not match the decision");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops the moment the plan's decision is no longer standing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const current = plan();
      // The owner cancelled the card between one step and the next.
      const approval = approvalFor(current, "cancelled");
      harness.approvals.set(approval.approvalId, approval);

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(
          gateway.call({
            operation: "github.create_repository",
            arguments: { name: "my-app", visibility: "private" },
            caller,
            planAuthorization: { approvalId: approval.approvalId, plan: current },
          }),
        );
        expect(error.reason).toContain("no longer approved");
        expect(harness.calls).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a value passed as an argument out of the vendor's own error", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: () =>
          Effect.fail(
            new Adapters.ConnectionVendorError({
              operationId: "vercel.set_environment_variables",
              // A vendor that quotes the request body back at us.
              detail: `rejected value ${DATABASE_URL} for DATABASE_URL`,
            }),
          ),
      });
      const built = buildCreateAppPlan({
        appName: "my-app",
        template: STATIC_APP_TEMPLATE,
        githubAccount: "octocat",
        repositoryName: "my-app",
        visibility: "private",
        branch: "main",
        vercelAccount: "octocat",
        vercelTeamName: null,
        projectName: "my-app",
        deploymentTarget: "production",
        environmentTargets: ["production"],
        dataStores: [
          {
            stepId: "neon.database",
            vendorId: "neon",
            title: "Create the database",
            resourceName: "my-app-db",
            region: "aws-eu-west-2",
            tier: "free",
            costCeiling: "free tier only",
            operationIds: ["neon.create_project"],
            targetResources: ["neon:project:my-app-db"],
            environmentKeys: ["DATABASE_URL"],
          },
        ],
      });
      if (built._tag === "Failure") throw new Error(built.failure);
      const current = built.success;
      const approval = approvalFor(current, "approved");
      harness.approvals.set(approval.approvalId, approval);

      yield* Effect.gen(function* () {
        const gateway = yield* Gateway.PersonalConnectionGateway;
        const error = yield* Effect.flip(
          gateway.call({
            operation: "vercel.set_environment_variables",
            arguments: {
              project: "my-app",
              target: "production",
              variables: [
                { key: "APP_ENVIRONMENT_LABEL", value: "hbots" },
                { key: "DATABASE_URL", value: DATABASE_URL },
              ],
            },
            caller,
            planAuthorization: { approvalId: approval.approvalId, plan: current },
            // The connection's own credential is scrubbed by default; a value
            // we are deliberately carrying through the argument channel has to
            // be named, or the vendor's reply prints it.
            scrub: [Redacted.make(DATABASE_URL)],
          }),
        );
        expect(error.reason).toContain("rejected value");
        expect(text(error)).not.toContain("s3cr3t-password");
        expect(text(harness.logs)).not.toContain("s3cr3t-password");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
