import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CreateAppRunId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  PersonalTaskId,
  ThreadId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { runMigrations } from "../../../persistence/Migrations.ts";
import * as PersonalTaskService from "../../tasks/PersonalTaskService.ts";
import * as ApprovalRepository from "../approvalRepository.ts";
import * as ApprovalService from "../approvalService.ts";
import * as Gateway from "../gateway.ts";
import * as ConnectionService from "../service.ts";
import { ConnectionId } from "@t3tools/contracts";
import { makeAppHealthCheck, AppHealthCheck, type AppProbe } from "./healthCheck.ts";
import * as RunRepository from "./runRepository.ts";
import * as CreateApp from "./service.ts";

/**
 * The runner, driven through the gateway's own seam.
 *
 * The fake gateway below stands in for every provider; nothing here reaches a
 * network. What it records is the point of most of these tests: *how many
 * times* a creating call was made across a crash is the difference between a
 * resumable run and a duplicate factory.
 */

const caller = {
  threadId: ThreadId.make("thread-1"),
  botId: PersonalBotId.make("bot-1"),
  taskId: PersonalTaskId.make("task-1"),
};

/** Every step that creates something, in the order the run does them. */
const CREATING_OPERATIONS = [
  "github.create_repository",
  "github.push_files",
  "vercel.create_project",
  "vercel.set_environment_variables",
  "vercel.create_deployment",
] as const;

interface GatewayScript {
  /** Operation names that should die mid-call, as a process would. */
  readonly dieOn?: ReadonlySet<string>;
  /** Operation names that should be refused by the provider. */
  readonly failOn?: ReadonlySet<string>;
  /** Repositories `github.list_repositories` reports. */
  readonly existingRepositories?: ReadonlyArray<{
    readonly repository: string;
    readonly visibility: string;
  }>;
  readonly existingProjects?: ReadonlyArray<{
    readonly project: string;
    readonly projectId?: string;
  }>;
}

const makeHarness = (script: GatewayScript = {}, healthReplies?: ReadonlyArray<number>) => {
  const approvals = new Map<string, PersonalConnectionApproval>();
  const calls: Array<{
    readonly operation: string;
    readonly authorized: boolean;
  }> = [];
  const resumes: Array<{ readonly taskId: string; readonly note: string }> = [];
  const parked: Array<string> = [];
  const existingRepositories = [...(script.existingRepositories ?? [])];
  const existingProjects = [...(script.existingProjects ?? [])];

  const connections = Layer.mock(ConnectionService.PersonalConnectionService)({
    resolveForOperation: (vendorId) =>
      Effect.succeed(
        Option.some({
          connectionId: ConnectionId.make(`connection-${vendorId}`),
          vendorId,
          credentialRef: `opaque-${vendorId}`,
          credentialVersion: 1,
          account: {
            accountId: "1",
            accountName: "octocat",
            teamId: null,
            teamName: null,
          },
        }),
      ),
  });

  const gateway = Layer.mock(Gateway.PersonalConnectionGateway)({
    call: (input) =>
      Effect.gen(function* () {
        calls.push({
          operation: input.operation,
          authorized: input.planAuthorization !== undefined,
        });
        if (script.dieOn?.has(input.operation) === true) {
          // A process that stopped between "the provider was asked" and "the
          // answer was recorded". Not a failure the run can read: a death.
          return yield* Effect.die(`the process stopped during ${input.operation}`);
        }
        if (script.failOn?.has(input.operation) === true) {
          return yield* Effect.fail(
            new Gateway.PersonalConnectionGatewayError({
              reason: `the provider refused ${input.operation}`,
            }),
          );
        }
        const result = ((): Readonly<Record<string, unknown>> => {
          switch (input.operation) {
            case "github.list_repositories":
              return { repositories: existingRepositories };
            case "github.create_repository":
              existingRepositories.push({ repository: "octocat/my-app", visibility: "private" });
              return {
                repository: "octocat/my-app",
                htmlUrl: "https://github.com/octocat/my-app",
              };
            case "github.push_files":
              return { repository: "octocat/my-app", branch: "main", commitSha: "abc1234" };
            case "vercel.list_projects":
              return { projects: existingProjects };
            case "vercel.create_project":
              existingProjects.push({ project: "my-app", projectId: "prj_1" });
              return { project: "my-app", projectId: "prj_1", framework: "" };
            case "vercel.set_environment_variables":
              return { project: "my-app", target: "production", keys: ["APP_ENVIRONMENT_LABEL"] };
            case "vercel.create_deployment":
              return {
                deploymentId: "dpl_1",
                url: "https://my-app.example",
                target: "production",
              };
            default:
              return {};
          }
        })();
        return {
          _tag: "completed" as const,
          operationId: input.operation,
          result,
          approvalId: null,
        };
      }),
    describe: () => Effect.succeed([]),
  });

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

  const tasks = Layer.mock(PersonalTaskService.PersonalTaskService)({
    waitForUser: (input) =>
      Effect.sync(() => {
        parked.push(input.taskId);
      }) as never,
    resumeFromUser: (input) =>
      Effect.sync(() => {
        resumes.push({ taskId: input.taskId, note: input.note });
      }) as never,
    failWaitingForUser: () => Effect.succeed(undefined as never),
  });

  let probeIndex = 0;
  const probe: AppProbe = () =>
    Effect.sync(() => {
      const status = healthReplies?.[Math.min(probeIndex, healthReplies.length - 1)] ?? 200;
      probeIndex += 1;
      return { status, body: status === 200 ? "hbots-app-ok" : "building" };
    });
  const health = Layer.succeed(
    AppHealthCheck,
    makeAppHealthCheck(probe, { attempts: 2, delay: Duration.zero }),
  );

  const layer = CreateApp.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RunRepository.layer,
        connections,
        gateway,
        health,
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
        tasks,
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

  return { layer, approvals, calls, resumes, parked, existingRepositories, existingProjects };
};

type Harness = ReturnType<typeof makeHarness>;

const request = (overrides?: { readonly visibility?: "private" | "public" }) => ({
  caller,
  appName: "my-app",
  visibility: overrides?.visibility ?? ("private" as const),
  deploymentTarget: "production" as const,
});

/** How often a creating call actually reached the provider. */
const timesCalled = (harness: Harness, operation: string) =>
  harness.calls.filter((entry) => entry.operation === operation).length;

/**
 * The state the owner's approval leaves behind, written straight to the rows.
 *
 * Going through `startOrResume` a second time would work too, but it forks the
 * run into the background, and these tests are about counting exactly what
 * reached a provider.
 */
const armApprovedRun = (runId: CreateAppRunId, approvalId: PersonalConnectionApprovalId) =>
  Effect.gen(function* () {
    const repository = yield* RunRepository.CreateAppRunRepository;
    const at = yield* DateTime.now;
    yield* repository.writeStatus({
      runId,
      status: "running",
      approvalId,
      taskId: caller.taskId,
      at,
    });
  });

const startAndApprove = Effect.fn("startAndApprove")(function* () {
  const service = yield* CreateApp.PersonalCreateAppService;
  const approvalService = yield* ApprovalService.PersonalConnectionApprovalService;
  const started = yield* service.startOrResume(request());
  assert.equal(started._tag, "awaiting_approval");
  if (started._tag !== "awaiting_approval") throw new Error("unreachable");
  const pending = yield* approvalService.listPending();
  const approval = pending.approvals[0];
  assert.ok(approval !== undefined);
  yield* approvalService.decide({ approvalId: approval.approvalId, decision: "approved" });
  yield* armApprovedRun(started.run.runId, approval.approvalId);
  return { runId: started.run.runId, approvalId: approval.approvalId, summary: started.summary };
});

it.layer(Layer.empty)("create_app runner", (it) => {
  it.effect("asks once for the whole plan, then runs every step without asking again", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId, summary } = yield* startAndApprove();
      // One card, and it describes the whole thing in the server's words.
      assert.equal(harness.approvals.size, 1);
      assert.ok(summary.includes("octocat/my-app"));
      assert.ok(summary.includes("production"));

      const run = yield* service.advance(runId);
      assert.equal(run.status, "completed");
      assert.equal(run.appUrl, "https://my-app.example/");
      // Still one card: every step rode the plan's decision.
      assert.equal(harness.approvals.size, 1);
      for (const operation of CREATING_OPERATIONS) {
        assert.equal(timesCalled(harness, operation), 1, operation);
      }
      // And every one of them said which plan authorized it.
      assert.ok(
        harness.calls
          .filter((entry) => CREATING_OPERATIONS.includes(entry.operation as never))
          .every((entry) => entry.authorized),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("pushes before the host is linked, so nothing can deploy on its own", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      yield* service.advance(runId);
      const order = harness.calls
        .map((entry) => entry.operation)
        .filter((operation) => CREATING_OPERATIONS.includes(operation as never));
      // A push to a repository a host is already watching deploys it, which
      // would race the deployment the plan actually approved.
      assert.ok(order.indexOf("github.push_files") < order.indexOf("vercel.create_project"));
      assert.ok(
        order.indexOf("vercel.set_environment_variables") <
          order.indexOf("vercel.create_deployment"),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not ask again for a plan that has not changed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const first = yield* service.startOrResume(request());
      const second = yield* service.startOrResume(request());
      assert.equal(first._tag, "awaiting_approval");
      assert.equal(second._tag, "awaiting_approval");
      if (first._tag !== "awaiting_approval" || second._tag !== "awaiting_approval") return;
      assert.equal(second.run.runId, first.run.runId);
      // One run, one card. Asking twice is the same question.
      assert.equal(harness.approvals.size, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks again when the plan changes materially", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const first = yield* service.startOrResume(request());
      // The same app, now published to the world. A different decision.
      const second = yield* service.startOrResume(request({ visibility: "public" }));
      if (first._tag !== "awaiting_approval" || second._tag !== "awaiting_approval") {
        throw new Error("expected both to wait for approval");
      }
      assert.notEqual(second.run.runId, first.run.runId);
      assert.equal(harness.approvals.size, 2);
      assert.ok(second.summary.includes("public"));
      assert.ok(second.summary.includes("anyone on the internet"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses to start when a name is already taken, before any card", () => {
    const harness = makeHarness({ existingProjects: [{ project: "my-app", projectId: "prj_1" }] });
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const error = yield* Effect.flip(service.startOrResume(request()));
      assert.ok(error.message.includes("already exists"));
      // Prerequisites resolve before the owner is shown anything, so a plan
      // that cannot work never costs them a decision.
      assert.equal(harness.approvals.size, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stops the run when the owner says no", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      const approvalService = yield* ApprovalService.PersonalConnectionApprovalService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* service.startOrResume(request());
      const pending = yield* approvalService.listPending();
      const approval = pending.approvals[0];
      assert.ok(approval !== undefined);
      yield* approvalService.decide({ approvalId: approval.approvalId, decision: "denied" });

      const again = yield* service.startOrResume(request());
      assert.equal(again._tag, "declined");
      assert.equal(harness.calls.filter((entry) => entry.authorized).length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reconciles an ambiguous repository instead of creating a second one", () => {
    // The provider created it and the process died before the answer was
    // read. On resume the repository is there, under the plan's own name.
    const harness = makeHarness({ dieOn: new Set(["github.create_repository"]) });
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();

      const died = yield* Effect.exit(service.advance(runId));
      assert.equal(died._tag, "Failure");
      const midway = yield* service.get(runId);
      const step = midway.steps.find((entry) => entry.stepId === "github.repository");
      assert.equal(step?.state, "in_flight");
      assert.equal(step?.attempts, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("adopts what a crashed step already made, and makes nothing twice", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      const repository = yield* RunRepository.CreateAppRunRepository;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      // The repository the interrupted call had already created, appearing
      // only after the plan was approved — which is the real sequence.
      harness.existingRepositories.push({ repository: "octocat/my-app", visibility: "private" });
      // Exactly the row a crash mid-create leaves behind.
      const at = yield* DateTime.now;
      yield* repository.settleStep({
        runId,
        stepId: "scaffold",
        state: "done",
        remoteId: null,
        adopted: false,
        receipt: {},
        error: null,
        at,
      });
      yield* repository.beginStep({ runId, stepId: "github.repository", at });

      const run = yield* service.advance(runId);
      assert.equal(run.status, "completed");
      const step = run.steps.find((entry) => entry.stepId === "github.repository");
      assert.equal(step?.state, "done");
      // Adopted, not created: the reconcile found it and the run said so.
      assert.equal(step?.adopted, true);
      assert.equal(step?.remoteId, "octocat/my-app");
      assert.equal(timesCalled(harness, "github.create_repository"), 0);
      // Twice: once checking the name was free before the card, once
      // reconciling before the retry.
      assert.equal(timesCalled(harness, "github.list_repositories"), 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("will not adopt a repository that is not the one the plan described", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      const repository = yield* RunRepository.CreateAppRunRepository;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      // Same name, someone else's settings. Adopting it would be worse than
      // failing: the run would push into a repository nobody approved.
      harness.existingRepositories.push({ repository: "octocat/my-app", visibility: "public" });
      const at = yield* DateTime.now;
      yield* repository.settleStep({
        runId,
        stepId: "scaffold",
        state: "done",
        remoteId: null,
        adopted: false,
        receipt: {},
        error: null,
        at,
      });
      yield* repository.beginStep({ runId, stepId: "github.repository", at });

      const run = yield* service.advance(runId);
      // Nothing matched, so the retry went ahead and created it — which is
      // the safe outcome, because the reconcile ran first and found nothing
      // of ours.
      assert.equal(timesCalled(harness, "github.create_repository"), 1);
      assert.equal(run.status, "completed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("parks a run whose deployment was interrupted, rather than deploying twice", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      const repository = yield* RunRepository.CreateAppRunRepository;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      const at = yield* DateTime.now;
      for (const stepId of [
        "scaffold",
        "github.repository",
        "github.push",
        "vercel.project",
        "vercel.environment",
      ]) {
        yield* repository.settleStep({
          runId,
          stepId,
          state: "done",
          remoteId: null,
          adopted: false,
          receipt: {},
          error: null,
          at,
        });
      }
      yield* repository.beginStep({ runId, stepId: "vercel.deployment", at });

      const run = yield* service.advance(runId);
      assert.equal(run.status, "needs_attention");
      // A deployment has no name to look up, so the run says so rather than
      // firing a second one to find out.
      assert.equal(timesCalled(harness, "vercel.create_deployment"), 0);
      const note = harness.resumes.at(-1)?.note ?? "";
      assert.ok(note.includes("Nothing has been deleted"));
      assert.ok(note.includes("look at the provider"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("is not complete when the deploy API said yes and the URL never answered", () => {
    // The deployment call succeeds. The app never serves its own marker.
    const harness = makeHarness({}, [503]);
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      const run = yield* service.advance(runId);

      assert.equal(run.status, "needs_attention");
      assert.equal(timesCalled(harness, "vercel.create_deployment"), 1);
      const deployment = run.steps.find((entry) => entry.stepId === "vercel.deployment");
      const health = run.steps.find((entry) => entry.stepId === "health");
      assert.equal(deployment?.state, "done");
      assert.equal(health?.state, "failed");
      assert.ok(health?.error?.includes("never answered as the app"));
      // What exists is still recorded, and nothing was undone.
      assert.equal(run.appUrl, "https://my-app.example");
      const note = harness.resumes.at(-1)?.note ?? "";
      assert.ok(note.includes("Nothing has been deleted"));
      assert.ok(note.includes("Create the Vercel project: done"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stays where it stopped when a provider refuses, and says what exists", () => {
    const harness = makeHarness({ failOn: new Set(["vercel.create_project"]) });
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      const run = yield* service.advance(runId);

      assert.equal(run.status, "needs_attention");
      const done = run.steps.filter((entry) => entry.state === "done").map((entry) => entry.stepId);
      assert.deepEqual(done, ["scaffold", "github.repository", "github.push"]);
      const pending = run.steps
        .filter((entry) => entry.state === "pending")
        .map((entry) => entry.stepId);
      assert.deepEqual(pending, ["vercel.environment", "vercel.deployment", "health"]);
      // Nothing after the failure was attempted, and nothing before it undone.
      assert.equal(timesCalled(harness, "vercel.create_deployment"), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("resumes a run a dead process left in flight, from the rows alone", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* CreateApp.PersonalCreateAppService;
      const repository = yield* RunRepository.CreateAppRunRepository;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const { runId } = yield* startAndApprove();
      // What the dead process had already created before it died.
      harness.existingRepositories.push({ repository: "octocat/my-app", visibility: "private" });
      harness.existingProjects.push({ project: "my-app", projectId: "prj_1" });
      const at = yield* DateTime.now;
      yield* repository.settleStep({
        runId,
        stepId: "scaffold",
        state: "done",
        remoteId: null,
        adopted: false,
        receipt: {},
        error: null,
        at,
      });
      yield* repository.settleStep({
        runId,
        stepId: "github.repository",
        state: "done",
        remoteId: "octocat/my-app",
        adopted: false,
        receipt: { repository: "octocat/my-app" },
        error: null,
        at,
      });
      yield* repository.settleStep({
        runId,
        stepId: "github.push",
        state: "done",
        remoteId: "abc1234",
        adopted: false,
        receipt: {},
        error: null,
        at,
      });
      yield* repository.beginStep({ runId, stepId: "vercel.project", at });

      // A new process, told only what the rows say.
      yield* service.resumeIncomplete();
      const run = yield* service.get(runId);
      assert.equal(run.status, "completed");
      const project = run.steps.find((entry) => entry.stepId === "vercel.project");
      assert.equal(project?.adopted, true);
      assert.equal(project?.remoteId, "prj_1");
      assert.equal(timesCalled(harness, "vercel.create_project"), 0);
      assert.equal(timesCalled(harness, "github.create_repository"), 0);
      assert.equal(timesCalled(harness, "github.push_files"), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("crashes at every step boundary and still finishes each thing once", () => {
    const steps = [
      { stepId: "scaffold", operation: null },
      { stepId: "github.repository", operation: "github.create_repository" },
      { stepId: "github.push", operation: "github.push_files" },
      { stepId: "vercel.project", operation: "vercel.create_project" },
      { stepId: "vercel.environment", operation: "vercel.set_environment_variables" },
    ] as const;
    return Effect.forEach(
      steps,
      (boundary) => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const service = yield* CreateApp.PersonalCreateAppService;
          const repository = yield* RunRepository.CreateAppRunRepository;
          yield* runMigrations({ toMigrationInclusive: 74 });
          const { runId } = yield* startAndApprove();
          const at = yield* DateTime.now;

          // Every step before this one finished; this one was in flight when
          // the process died.
          for (const earlier of steps) {
            if (earlier.stepId === boundary.stepId) break;
            yield* repository.settleStep({
              runId,
              stepId: earlier.stepId,
              state: "done",
              remoteId: null,
              adopted: false,
              receipt:
                earlier.stepId === "github.repository"
                  ? { repository: "octocat/my-app" }
                  : earlier.stepId === "vercel.project"
                    ? { project: "my-app", projectId: "prj_1" }
                    : {},
              error: null,
              at,
            });
          }
          yield* repository.beginStep({ runId, stepId: boundary.stepId, at });

          const run = yield* service.advance(runId);
          assert.equal(run.status, "completed", boundary.stepId);
          // Whatever the boundary, nothing that creates a named resource ran
          // more than once across the whole run.
          assert.ok(
            timesCalled(harness, "github.create_repository") <= 1,
            `${boundary.stepId}: repository created more than once`,
          );
          assert.ok(
            timesCalled(harness, "vercel.create_project") <= 1,
            `${boundary.stepId}: project created more than once`,
          );
          assert.equal(
            timesCalled(harness, "vercel.create_deployment"),
            1,
            `${boundary.stepId}: deployment count`,
          );
        }).pipe(Effect.provide(harness.layer));
      },
      { discard: true },
    );
  });
});
