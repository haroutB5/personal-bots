import * as NodeCrypto from "node:crypto";

import {
  CreateAppError,
  CreateAppRunId,
  type CreateAppDataStorePlan,
  type CreateAppDeploymentTarget,
  type CreateAppPlan,
  type CreateAppRepositoryVisibility,
  type CreateAppRun,
  type CreateAppStep,
  type PersonalBotId,
  type PersonalTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import * as PersonalTaskService from "../../tasks/PersonalTaskService.ts";
import * as ApprovalService from "../approvalService.ts";
import * as Gateway from "../gateway.ts";
import * as ConnectionService from "../service.ts";
import * as HealthCheck from "./healthCheck.ts";
import { AppHealthCheck } from "./healthCheck.ts";
import {
  buildCreateAppPlan,
  createAppPlanDigest,
  describePlan,
  planResourceUniverse,
} from "./plan.ts";
import * as RunRepository from "./runRepository.ts";
import {
  buildCreateAppSteps,
  CreateAppStepError,
  type CreateAppStepContext,
  type CreateAppStepDefinition,
  type CreateAppStepOutcome,
} from "./steps.ts";
import { STATIC_APP_TEMPLATE } from "./template.ts";

/**
 * `create_app`: plan once, approve once, then run.
 *
 * ## Where the durability lives
 *
 * In the rows, not in a fiber. `advance` is a loop over persisted step state
 * that can be entered from anywhere — the first call, the resume after the
 * owner answers, or a fresh process after a crash — and always does the same
 * thing: find the first step that is not finished, and carry on from there.
 * There is no scheduler here; parking and resuming the asking task is the
 * existing `PersonalTaskService`, and the decision is the existing approval
 * service.
 *
 * ## Why the plan approval is an ordinary approval row
 *
 * Because everything that makes approvals work is already there: one card per
 * digest, a duplicate click from a second device resolving once, lazy expiry
 * with no timer to lose, and a task parked and released through one path. The
 * plan's hash goes in as the action digest, so the same plan asked for twice
 * finds the same decision — which is exactly "an unchanged plan does not
 * prompt again" — and a changed plan is a different digest and a new card.
 *
 * The one difference from a per-call approval is the receipt. A per-call
 * approval is spent by its call; a plan's receipt is written once, when the
 * run reaches a terminal state, because the plan authorized a sequence.
 */

export interface CreateAppCaller {
  readonly threadId: ThreadId;
  readonly botId: PersonalBotId;
  /** The task to park while the owner decides and while the run works. */
  readonly taskId: PersonalTaskId | null;
}

export interface CreateAppRequest {
  readonly caller: CreateAppCaller;
  readonly appName: string;
  readonly visibility: CreateAppRepositoryVisibility;
  readonly deploymentTarget: CreateAppDeploymentTarget;
  readonly dataStores?: ReadonlyArray<CreateAppDataStorePlan>;
}

export type CreateAppStartResult =
  | {
      readonly _tag: "awaiting_approval";
      readonly run: CreateAppRun;
      /** Server-authored plan text, as the owner is reading it. */
      readonly summary: string;
      readonly note: string;
    }
  | { readonly _tag: "running"; readonly run: CreateAppRun }
  | { readonly _tag: "completed"; readonly run: CreateAppRun }
  | { readonly _tag: "needs_attention"; readonly run: CreateAppRun; readonly message: string }
  | { readonly _tag: "declined"; readonly run: CreateAppRun; readonly message: string };

export const AWAITING_PLAN_NOTE =
  "The user has been asked to approve the whole plan. Tell them in one sentence what you are about to build, then end your turn. You continue automatically when they answer; do not ask them to tell you.";

export class PersonalCreateAppService extends Context.Service<
  PersonalCreateAppService,
  {
    /**
     * Resolves prerequisites, builds the plan, and either raises one card or
     * carries on. Idempotent for an unchanged plan in the same chat.
     */
    readonly startOrResume: (
      request: CreateAppRequest,
    ) => Effect.Effect<CreateAppStartResult, CreateAppError>;
    /** Runs every remaining step of an approved run. Safe to enter twice. */
    readonly advance: (runId: CreateAppRunId) => Effect.Effect<CreateAppRun, CreateAppError>;
    readonly get: (runId: CreateAppRunId) => Effect.Effect<CreateAppRun, CreateAppError>;
    /** Picks up runs a dead process left mid-flight. Called once at startup. */
    readonly resumeIncomplete: () => Effect.Effect<void>;
  }
>()("t3/personal/connections/createApp/service/PersonalCreateAppService") {}

export const make = Effect.gen(function* () {
  const runs = yield* RunRepository.CreateAppRunRepository;
  const connections = yield* ConnectionService.PersonalConnectionService;
  const approvals = yield* ApprovalService.PersonalConnectionApprovalService;
  const gateway = yield* Gateway.PersonalConnectionGateway;
  const health = yield* AppHealthCheck;
  const tasks = yield* PersonalTaskService.PersonalTaskService;
  // One run advances at a time. Two fibers walking the same step rows would
  // be the duplicate factory this whole design is about, and app creation is
  // rare enough that serialising it costs nothing worth having.
  const lock = yield* Semaphore.make(1);

  const fail = (message: string) => new CreateAppError({ message });
  const db = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(() => fail(`The create_app run could not be ${operation}.`)));

  /**
   * Both connections, resolved before the owner is shown anything. A plan
   * naming an account that is not connected is a plan that cannot be carried
   * out, and finding that out after approval would waste the decision.
   */
  const prerequisites = Effect.fn("PersonalCreateAppService.prerequisites")(function* () {
    const github = yield* connections
      .resolveForOperation("github")
      .pipe(Effect.mapError((error) => fail(error.message)));
    const vercel = yield* connections
      .resolveForOperation("vercel")
      .pipe(Effect.mapError((error) => fail(error.message)));
    const missing = [
      ...(Option.isNone(github) ? ["GitHub"] : []),
      ...(Option.isNone(vercel) ? ["Vercel"] : []),
    ];
    if (Option.isNone(github) || Option.isNone(vercel)) {
      return yield* fail(
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not connected, so there is nothing to build an app with. Ask the user to connect ${missing.join(" and ")} in Settings; you cannot connect ${missing.length === 1 ? "it" : "them"} yourself.`,
      );
    }
    const githubAccount = github.value.account?.accountName ?? null;
    const vercelAccount = vercel.value.account?.accountName ?? null;
    if (githubAccount === null || vercelAccount === null) {
      return yield* fail(
        "One of the connections has not been checked against its provider yet, so its account is unknown. Ask the user to press Check now in Settings.",
      );
    }
    return {
      github: github.value,
      vercel: vercel.value,
      githubAccount,
      vercelAccount,
      vercelTeamName: vercel.value.account?.teamName ?? null,
    };
  });

  /** A plain gateway call with no plan behind it: the read-only checks. */
  const read = (caller: CreateAppCaller, operation: string) =>
    gateway.call({ operation, arguments: {}, caller }).pipe(
      Effect.mapError((error) => fail(error.reason)),
      Effect.flatMap((outcome) =>
        outcome._tag === "completed"
          ? Effect.succeed(outcome.result)
          : fail(`${operation} unexpectedly asked for approval.`),
      ),
    );

  /**
   * The names the plan will use, checked to be free *before* the card.
   *
   * A name already taken is the difference between a plan that works and one
   * that fails on its second step, and the owner should be told while they can
   * still choose a different name.
   */
  const namesAreFree = Effect.fn("PersonalCreateAppService.namesAreFree")(function* (input: {
    readonly caller: CreateAppCaller;
    readonly repository: string;
    readonly project: string;
  }) {
    const repositories = yield* read(input.caller, "github.list_repositories");
    const repositoryRows = repositories["repositories"];
    if (
      (Array.isArray(repositoryRows) ? repositoryRows : []).some(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          (row as { readonly repository?: unknown }).repository === input.repository,
      )
    ) {
      return yield* fail(
        `The GitHub repository ${input.repository} already exists. Ask the user for a different app name; nothing has been created.`,
      );
    }
    const projects = yield* read(input.caller, "vercel.list_projects");
    const projectRows = projects["projects"];
    if (
      (Array.isArray(projectRows) ? projectRows : []).some(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          (row as { readonly project?: unknown }).project === input.project,
      )
    ) {
      return yield* fail(
        `The Vercel project ${input.project} already exists. Ask the user for a different app name; nothing has been created.`,
      );
    }
  });

  const definitionsFor = (plan: CreateAppPlan) =>
    buildCreateAppSteps(plan).pipe(Effect.mapError((error) => fail(error.reason)));

  const requireRun = (runId: CreateAppRunId) =>
    db("read", runs.get(runId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => fail("That create_app run does not exist."),
          onSome: (run: CreateAppRun) => Effect.succeed(run),
        }),
      ),
    );

  /** Every terminal ending goes through here: one receipt, one resumed task. */
  const finish = Effect.fn("PersonalCreateAppService.finish")(function* (
    run: CreateAppRun,
    status: "completed" | "needs_attention" | "declined",
    note: string,
    appUrl?: string,
  ) {
    const at = yield* DateTime.now;
    yield* db(
      "written",
      runs.writeStatus({
        runId: run.runId,
        status,
        at,
        ...(appUrl === undefined ? {} : { appUrl }),
      }),
    );
    if (run.approvalId !== null) {
      // The plan's single receipt. Written here rather than per step, because
      // a plan authorized a sequence, and the sequence is what just ended.
      yield* approvals
        .recordExecution({
          approvalId: run.approvalId,
          outcome: status === "completed" ? "succeeded" : "failed",
        })
        .pipe(Effect.ignore);
    }
    if (run.taskId !== null) {
      yield* tasks
        .resumeFromUser({
          taskId: run.taskId,
          noteId: `create-app:${run.runId}:${status}`,
          note,
          // Nothing about the provider environment changed; the credentials
          // never went near the session.
          restartSession: false,
        })
        .pipe(Effect.ignore);
    }
    return yield* requireRun(run.runId);
  });

  /** What exists and what does not, in the owner's words. Never a guess. */
  const describeProgress = (run: CreateAppRun, steps: ReadonlyArray<CreateAppStep>) =>
    steps
      .map((step) => {
        const made =
          step.remoteId === null
            ? ""
            : ` (${step.adopted ? "found already there" : "created"}: ${step.remoteId})`;
        return `- ${step.title}: ${step.state}${made}${step.error === null ? "" : ` — ${step.error}`}`;
      })
      .join("\n")
      .concat(run.appUrl === null ? "" : `\nURL: ${run.appUrl}`);

  const advanceUnlocked = Effect.fn("PersonalCreateAppService.advance")(function* (
    runId: CreateAppRunId,
  ) {
    let run = yield* requireRun(runId);
    if (run.status !== "running") return run;
    const definitions = yield* definitionsFor(run.plan);
    if (run.approvalId === null) {
      return yield* fail("That run has no approved plan, so nothing ran.");
    }
    const approvalId = run.approvalId;

    const receipts: Record<string, Readonly<Record<string, string>>> = {};
    for (const step of run.steps) receipts[step.stepId] = step.receipt;
    // Values a data-store step produced. In memory for this process only: a
    // crash loses them, and the step that made them is re-entered rather than
    // the secret being persisted somewhere it could be read.
    const secrets: Record<string, Redacted.Redacted<string>> = {};

    const context = (definition: CreateAppStepDefinition): CreateAppStepContext => ({
      plan: run.plan,
      run,
      receipts,
      secrets,
      health,
      call: (request) =>
        gateway
          .call({
            operation: request.operationId,
            arguments: request.arguments,
            caller: { threadId: run.threadId, botId: run.botId, taskId: run.taskId },
            planAuthorization: { approvalId, plan: run.plan },
            ...(request.scrub === undefined ? {} : { scrub: request.scrub }),
          })
          .pipe(
            Effect.mapError((error) => new CreateAppStepError({ reason: error.reason })),
            Effect.flatMap((outcome) =>
              outcome._tag === "completed"
                ? Effect.succeed(outcome.result)
                : Effect.fail(
                    new CreateAppStepError({
                      reason: `${definition.title} unexpectedly asked for a separate approval, so the run stopped.`,
                    }),
                  ),
            ),
          ),
    });

    const record = (stepId: string, outcome: CreateAppStepOutcome) => {
      receipts[stepId] = outcome.receipt;
      for (const [key, value] of Object.entries(outcome.secrets ?? {})) secrets[key] = value;
    };

    for (const definition of definitions) {
      const persisted = run.steps.find((step) => step.stepId === definition.stepId);
      if (persisted === undefined) {
        return yield* fail(
          `The run has no record of the step ${definition.stepId}, so it cannot be continued safely.`,
        );
      }
      if (persisted.state === "done" || persisted.state === "skipped") continue;

      // A retry, not a first attempt. Everything ambiguous is decided here,
      // before anything is sent.
      if (persisted.attempts > 0) {
        if (definition.retryPolicy === "manual") {
          const note = `The run stopped part-way and cannot safely continue on its own.\n\n${describeProgress(run, run.steps)}\n\nThe step "${definition.title}" was interrupted after the provider had been asked, and this build has no way to check what it did. Nothing has been deleted. Tell the user what exists, and that they should look at the provider before asking you to try again.`;
          return yield* finish(run, "needs_attention", note);
        }
        if (definition.retryPolicy === "reconcile") {
          const found = yield* definition.reconcile(context(definition)).pipe(
            Effect.map(Option.some),
            // A reconcile that itself failed tells us nothing, and "we could
            // not check" is not permission to create a second one.
            Effect.catch(() => Effect.succeed(Option.none<Option.Option<CreateAppStepOutcome>>())),
          );
          if (Option.isNone(found)) {
            const note = `The run could not check what already exists before retrying "${definition.title}", so it stopped rather than risk creating a second one.\n\n${describeProgress(run, run.steps)}`;
            return yield* finish(run, "needs_attention", note);
          }
          if (Option.isSome(found.value)) {
            const at = yield* DateTime.now;
            const outcome = found.value.value;
            yield* db(
              "written",
              runs.settleStep({
                runId,
                stepId: definition.stepId,
                state: "done",
                remoteId: outcome.remoteId,
                // Adopted, not created: the owner can see the difference and
                // so can anyone reading the run later.
                adopted: true,
                receipt: outcome.receipt,
                error: null,
                at,
              }),
            );
            record(definition.stepId, outcome);
            run = yield* requireRun(runId);
            continue;
          }
        }
      }

      const startedAt = yield* DateTime.now;
      yield* db("written", runs.beginStep({ runId, stepId: definition.stepId, at: startedAt }));
      const attempt = yield* definition.execute(context(definition)).pipe(Effect.result);
      const endedAt = yield* DateTime.now;

      if (attempt._tag === "Failure") {
        yield* db(
          "written",
          runs.settleStep({
            runId,
            stepId: definition.stepId,
            state: "failed",
            remoteId: null,
            adopted: false,
            receipt: {},
            error: attempt.failure.reason,
            at: endedAt,
          }),
        );
        run = yield* requireRun(runId);
        const note = `The app was not finished.\n\n${describeProgress(run, run.steps)}\n\nNothing has been deleted, and everything above that exists is still there. Tell the user what got done and what stopped it.`;
        return yield* finish(run, "needs_attention", note);
      }

      const outcome = attempt.success;
      yield* db(
        "written",
        runs.settleStep({
          runId,
          stepId: definition.stepId,
          state: "done",
          remoteId: outcome.remoteId,
          adopted: false,
          receipt: outcome.receipt,
          error: null,
          at: endedAt,
        }),
      );
      if (outcome.appUrl !== undefined) {
        yield* db(
          "written",
          runs.writeStatus({ runId, status: "running", appUrl: outcome.appUrl, at: endedAt }),
        );
      }
      record(definition.stepId, outcome);
      run = yield* requireRun(runId);
    }

    return yield* finish(
      run,
      "completed",
      `The app is live at ${run.appUrl ?? "the deployed URL"} and the URL answered as the app itself, not just as an accepted deployment.\n\n${describeProgress(run, run.steps)}`,
      run.appUrl ?? undefined,
    );
  });

  const startOrResumeUnlocked = Effect.fn("PersonalCreateAppService.startOrResume")(function* (
    request: CreateAppRequest,
  ) {
    const resolved = yield* prerequisites();
    const built = buildCreateAppPlan({
      appName: request.appName,
      template: STATIC_APP_TEMPLATE,
      githubAccount: resolved.githubAccount,
      repositoryName: request.appName,
      visibility: request.visibility,
      branch: "main",
      vercelAccount: resolved.vercelAccount,
      vercelTeamName: resolved.vercelTeamName,
      projectName: request.appName,
      deploymentTarget: request.deploymentTarget,
      // Variables are set on the environment being deployed, and on no other.
      environmentTargets: [request.deploymentTarget],
      dataStores: request.dataStores ?? [],
    });
    if (built._tag === "Failure") return yield* fail(built.failure);
    const plan = built.success;
    const planDigest = createAppPlanDigest(plan);

    const existing = yield* db(
      "read",
      runs.getByPlan({ threadId: request.caller.threadId, planDigest }),
    );
    let run: CreateAppRun;
    if (Option.isSome(existing)) {
      run = existing.value;
      if (run.status === "completed") return { _tag: "completed" as const, run };
    } else {
      // Only a plan nobody has approved yet needs its names checked: a run
      // already under way owns them.
      yield* namesAreFree({
        caller: request.caller,
        repository: plan.github.repository,
        project: plan.vercel.project,
      });
      const definitions = yield* definitionsFor(plan);
      const at = yield* DateTime.now;
      run = {
        runId: CreateAppRunId.make(NodeCrypto.randomUUID()),
        botId: request.caller.botId,
        threadId: request.caller.threadId,
        taskId: request.caller.taskId,
        plan,
        planDigest,
        approvalId: null,
        status: "awaiting_approval",
        appUrl: null,
        steps: definitions.map((definition, position) => ({
          stepId: definition.stepId,
          title: definition.title,
          position,
          state: "pending",
          attempts: 0,
          remoteId: null,
          adopted: false,
          receipt: {},
          error: null,
          startedAt: null,
          endedAt: null,
        })),
        createdAt: at,
        updatedAt: at,
      };
      yield* db("created", runs.insert(run));
    }

    const decision = yield* approvals
      .require({
        // The plan's own hash. The same plan finds the same decision, which is
        // what stops an unchanged plan from asking twice.
        actionDigest: planDigest,
        connectionId: resolved.vercel.connectionId,
        vendorId: "vercel",
        operationId: "workflow.create_app",
        riskReason: plan.github.visibility === "public" ? "publication" : "deployment",
        summary: describePlan(plan),
        targetResources: [...planResourceUniverse(plan)].toSorted(),
        credentialVersion: resolved.vercel.credentialVersion,
        threadId: request.caller.threadId,
        botId: request.caller.botId,
        taskId: request.caller.taskId,
      })
      .pipe(Effect.mapError((error) => fail(error.message)));

    const at = yield* DateTime.now;
    if (decision._tag === "pending") {
      yield* db("written", runs.writeStatus({ runId: run.runId, status: "awaiting_approval", at }));
      return {
        _tag: "awaiting_approval" as const,
        run: yield* requireRun(run.runId),
        summary: decision.approval.summary,
        note: AWAITING_PLAN_NOTE,
      };
    }
    if (decision._tag === "denied") {
      const declined = yield* finish(
        { ...run, approvalId: null },
        "declined",
        ApprovalService.denialResumeNote(decision.approval),
      );
      return {
        _tag: "declined" as const,
        run: declined,
        message: ApprovalService.denialResumeNote(decision.approval),
      };
    }
    if (decision._tag === "expired") {
      // Still awaiting: the owner never answered, and the next ask raises a
      // fresh card once the recent-expiry window has passed.
      return {
        _tag: "awaiting_approval" as const,
        run: yield* requireRun(run.runId),
        summary: decision.approval.summary,
        note: ApprovalService.expiryResumeNote(decision.approval),
      };
    }

    yield* db(
      "written",
      runs.writeStatus({
        runId: run.runId,
        status: "running",
        approvalId: decision.approval.approvalId,
        taskId: request.caller.taskId,
        at,
      }),
    );
    // Parked for the length of the run, not just the decision: the steps take
    // minutes, and a chat that reads idle while they happen is a chat that has
    // lost track of its own work.
    if (request.caller.taskId !== null) {
      yield* tasks.waitForUser({ taskId: request.caller.taskId }).pipe(Effect.ignore);
    }
    return { _tag: "running" as const, run: yield* requireRun(run.runId) };
  });

  const advance = (runId: CreateAppRunId) => lock.withPermit(advanceUnlocked(runId));

  return PersonalCreateAppService.of({
    startOrResume: (request) =>
      lock.withPermit(startOrResumeUnlocked(request)).pipe(
        Effect.tap((result) =>
          result._tag === "running"
            ? // Detached on purpose: the steps outlive the call that started
              // them, and the run's own rows are what carries it, not this
              // fiber. A process that dies here resumes from the rows.
              Effect.forkDetach(advance(result.run.runId).pipe(Effect.ignore))
            : Effect.void,
        ),
      ),
    advance,
    get: requireRun,
    resumeIncomplete: () =>
      db("read", runs.listByStatus("running")).pipe(
        Effect.flatMap((incomplete) =>
          Effect.forEach(incomplete, (run) => advance(run.runId).pipe(Effect.ignore), {
            discard: true,
          }),
        ),
        Effect.ignore,
      ),
  });
});

export const layer = Layer.effect(PersonalCreateAppService, make);
export const layerLive = layer.pipe(
  Layer.provideMerge(RunRepository.layer),
  Layer.provideMerge(HealthCheck.layer),
);
