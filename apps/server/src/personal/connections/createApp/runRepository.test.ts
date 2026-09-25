import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CreateAppRunId,
  PersonalBotId,
  ThreadId,
  type CreateAppPlan,
  type CreateAppRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { runMigrations } from "../../../persistence/Migrations.ts";
import { buildCreateAppPlan, createAppPlanDigest } from "./plan.ts";
import * as RunRepository from "./runRepository.ts";
import { STATIC_APP_TEMPLATE } from "./template.ts";

const plan = (appName: string): CreateAppPlan => {
  const built = buildCreateAppPlan({
    appName,
    template: STATIC_APP_TEMPLATE,
    githubAccount: "octocat",
    repositoryName: appName,
    visibility: "private",
    branch: "main",
    vercelAccount: "octocat",
    vercelTeamName: null,
    projectName: appName,
    deploymentTarget: "production",
    environmentTargets: ["production"],
    dataStores: [],
  });
  if (built._tag === "Failure") throw new Error(built.failure);
  return built.success;
};

const newRun = (input: { readonly runId: string; readonly appName: string }): CreateAppRun => {
  const value = plan(input.appName);
  const at = DateTime.makeUnsafe("2026-09-21T00:00:00.000Z");
  return {
    runId: CreateAppRunId.make(input.runId),
    botId: PersonalBotId.make("bot-1"),
    threadId: ThreadId.make("thread-1"),
    taskId: null,
    plan: value,
    planDigest: createAppPlanDigest(value),
    approvalId: null,
    status: "awaiting_approval",
    appUrl: null,
    steps: [
      {
        stepId: "github.repository",
        title: "Create the repository",
        position: 0,
        state: "pending",
        attempts: 0,
        remoteId: null,
        adopted: false,
        receipt: {},
        error: null,
        startedAt: null,
        endedAt: null,
      },
      {
        stepId: "vercel.project",
        title: "Create the project",
        position: 1,
        state: "pending",
        attempts: 0,
        remoteId: null,
        adopted: false,
        receipt: {},
        error: null,
        startedAt: null,
        endedAt: null,
      },
    ],
    createdAt: at,
    updatedAt: at,
  };
};

const layer = RunRepository.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.layer(layer)("create_app run repository", (it) => {
  it.effect("stores a plan whole and reads it back unchanged", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 74 });
      const repository = yield* RunRepository.CreateAppRunRepository;
      const run = newRun({ runId: "run-round-trip", appName: "round-trip" });
      yield* repository.insert(run);

      const found = yield* repository.get(run.runId);
      assert.ok(Option.isSome(found));
      // The plan is the approved text: a round trip that changed one field
      // would be a run executing something nobody agreed to.
      assert.deepEqual(found.value.plan, run.plan);
      assert.equal(found.value.planDigest, run.planDigest);
      assert.equal(found.value.steps.length, 2);
      assert.equal(found.value.steps[0]?.stepId, "github.repository");
    }),
  );

  it.effect("finds the run for a plan that was already approved in this chat", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 74 });
      const repository = yield* RunRepository.CreateAppRunRepository;
      const run = newRun({ runId: "run-same-plan", appName: "same-plan" });
      yield* repository.insert(run);

      const again = yield* repository.getByPlan({
        threadId: run.threadId,
        planDigest: run.planDigest,
      });
      assert.ok(Option.isSome(again));
      assert.equal(again.value.runId, run.runId);

      // A different plan is a different run, which is how a material change
      // reaches a fresh decision instead of riding the old one.
      const other = yield* repository.getByPlan({
        threadId: run.threadId,
        planDigest: createAppPlanDigest(plan("something-else")),
      });
      assert.ok(Option.isNone(other));
    }),
  );

  it.effect("records a step as in flight before the provider is called", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 74 });
      const repository = yield* RunRepository.CreateAppRunRepository;
      const run = newRun({ runId: "run-in-flight", appName: "in-flight" });
      yield* repository.insert(run);
      const at = DateTime.makeUnsafe("2026-09-21T00:01:00.000Z");

      yield* repository.beginStep({ runId: run.runId, stepId: "github.repository", at });
      const during = yield* repository.get(run.runId);
      assert.ok(Option.isSome(during));
      const step = during.value.steps.find((entry) => entry.stepId === "github.repository");
      // This is the whole point of the table: a crash here leaves a row that
      // says the provider was asked and the answer was never read.
      assert.equal(step?.state, "in_flight");
      assert.equal(step?.attempts, 1);
      assert.ok(step?.startedAt !== null);

      yield* repository.beginStep({ runId: run.runId, stepId: "github.repository", at });
      const second = yield* repository.get(run.runId);
      assert.equal(
        Option.isSome(second)
          ? second.value.steps.find((entry) => entry.stepId === "github.repository")?.attempts
          : null,
        2,
      );
    }),
  );

  it.effect("keeps the remote identity a step created, and what it was", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 74 });
      const repository = yield* RunRepository.CreateAppRunRepository;
      const run = newRun({ runId: "run-identity", appName: "identity" });
      yield* repository.insert(run);
      const at = DateTime.makeUnsafe("2026-09-21T00:01:00.000Z");

      yield* repository.beginStep({ runId: run.runId, stepId: "github.repository", at });
      yield* repository.settleStep({
        runId: run.runId,
        stepId: "github.repository",
        state: "done",
        remoteId: "octocat/identity",
        adopted: true,
        receipt: { repository: "octocat/identity", htmlUrl: "https://github.com/octocat/identity" },
        error: null,
        at,
      });

      const found = yield* repository.get(run.runId);
      assert.ok(Option.isSome(found));
      const step = found.value.steps.find((entry) => entry.stepId === "github.repository");
      assert.equal(step?.state, "done");
      assert.equal(step?.remoteId, "octocat/identity");
      // Adopted says the run found this rather than making it, which is the
      // difference between a resumed run and a duplicate factory.
      assert.equal(step?.adopted, true);
      assert.equal(step?.receipt["htmlUrl"], "https://github.com/octocat/identity");
    }),
  );

  it.effect("lists the runs a restarted process has to pick up", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 74 });
      const repository = yield* RunRepository.CreateAppRunRepository;
      const running = newRun({ runId: "run-running", appName: "running" });
      const finished = newRun({ runId: "run-finished", appName: "finished" });
      yield* repository.insert(running);
      yield* repository.insert(finished);
      const at = DateTime.makeUnsafe("2026-09-21T00:02:00.000Z");

      yield* repository.writeStatus({ runId: running.runId, status: "running", at });
      yield* repository.writeStatus({
        runId: finished.runId,
        status: "completed",
        appUrl: "https://finished.example",
        at,
      });

      const unfinished = yield* repository.listByStatus("running");
      assert.deepEqual(
        unfinished.map((entry) => entry.runId),
        [running.runId],
      );
      const done = yield* repository.get(finished.runId);
      assert.equal(Option.isSome(done) ? done.value.appUrl : null, "https://finished.example");
    }),
  );
});
