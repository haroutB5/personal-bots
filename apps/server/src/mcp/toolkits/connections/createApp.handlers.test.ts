import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import {
  CreateAppRunId,
  EnvironmentId,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  type CreateAppRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import {
  buildCreateAppPlan,
  createAppPlanDigest,
} from "../../../personal/connections/createApp/plan.ts";
import * as CreateApp from "../../../personal/connections/createApp/service.ts";
import { STATIC_APP_TEMPLATE } from "../../../personal/connections/createApp/template.ts";
import * as Gateway from "../../../personal/connections/gateway.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ConnectionsToolkitHandlersLive } from "./handlers.ts";
import { ConnectionsToolkit } from "./tools.ts";

/**
 * The model-facing half of `create_app`.
 *
 * What matters here is what comes back: the plan text the owner is reading is
 * the server's, the run's steps say what exists, and nothing in any of it is a
 * credential or a value.
 */

const text = (value: unknown) =>
  NodeUtil.inspect(value, { depth: null, breakLength: Infinity, maxStringLength: null });

const plan = () => {
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

const runRow = (status: CreateAppRun["status"]): CreateAppRun => {
  const value = plan();
  const at = DateTime.makeUnsafe("2026-09-21T00:00:00.000Z");
  return {
    runId: CreateAppRunId.make("run-1"),
    botId: PersonalBotId.make("bot"),
    threadId: ThreadId.make("thread"),
    taskId: null,
    plan: value,
    planDigest: createAppPlanDigest(value),
    approvalId: null,
    status,
    appUrl: status === "completed" ? "https://my-app.example/" : null,
    steps: [
      {
        stepId: "github.repository",
        title: "Create the GitHub repository",
        position: 0,
        state: "done",
        attempts: 1,
        remoteId: "octocat/my-app",
        adopted: false,
        receipt: { repository: "octocat/my-app" },
        error: null,
        startedAt: at,
        endedAt: at,
      },
      {
        stepId: "vercel.deployment",
        title: "Deploy the app",
        position: 1,
        state: status === "completed" ? "done" : "pending",
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

const harness = (createApp: Partial<CreateApp.PersonalCreateAppService["Service"]>) =>
  ConnectionsToolkitHandlersLive.pipe(
    Layer.provide(Layer.mock(CreateApp.PersonalCreateAppService)(createApp)),
    Layer.provide(
      Layer.mock(Gateway.PersonalConnectionGateway)({
        call: () => Effect.die("no connection_call in these tests"),
        describe: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(PersonalBotRepository)({
        getThreadLink: () =>
          Effect.succeed(
            Option.some({
              threadId: ThreadId.make("thread"),
              botId: PersonalBotId.make("bot"),
            } as never),
          ),
      }),
    ),
    Layer.provide(Layer.mock(PersonalTaskService.PersonalTaskService)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeedNone,
      }),
    ),
  );

const invoke = <A>(effect: Effect.Effect<A, never, never>) => effect;

const withContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, McpInvocationContext, {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["bots"] as const),
    issuedAt: 1,
  });

describe("create_app toolkit", () => {
  it.effect("hands back the server's plan text and the note that ends the turn", () => {
    const requests: Array<CreateApp.CreateAppRequest> = [];
    const layer = harness({
      startOrResume: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return {
            _tag: "awaiting_approval" as const,
            run: runRow("awaiting_approval"),
            summary: "Create the app my-app and put it live.",
            note: CreateApp.AWAITING_PLAN_NOTE,
          };
        }),
    });
    return withContext(
      Effect.gen(function* () {
        const toolkit = yield* ConnectionsToolkit;
        const results = yield* invoke(
          toolkit
            .handle("create_app", {
              appName: "my-app",
              visibility: "private",
              deploymentTarget: "production",
            })
            .pipe(Stream.unwrap, Stream.runCollect) as never,
        );
        const encoded = text(results);
        expect(encoded).toContain("awaiting_approval");
        expect(encoded).toContain("Create the app my-app and put it live.");
        expect(encoded).toContain("end your turn");
        // The target is passed through exactly as named; nothing is defaulted
        // on the way to the service.
        expect(requests[0]?.deploymentTarget).toBe("production");
        expect(requests[0]?.visibility).toBe("private");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("reports what exists after a run stopped part-way", () => {
    const layer = harness({
      get: () => Effect.succeed(runRow("needs_attention")),
    });
    return withContext(
      Effect.gen(function* () {
        const toolkit = yield* ConnectionsToolkit;
        const results = yield* invoke(
          toolkit
            .handle("create_app_status", { runId: "run-1" })
            .pipe(Stream.unwrap, Stream.runCollect) as never,
        );
        const encoded = text(results);
        expect(encoded).toContain("needs_attention");
        // What the provider called what exists, so the bot can tell the owner
        // rather than guess or offer to clean up.
        expect(encoded).toContain("octocat/my-app");
        expect(encoded).toContain("Create the GitHub repository");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("passes a refusal through in the server's words", () => {
    const layer = harness({
      startOrResume: () =>
        Effect.fail(
          new (class extends Error {
            override readonly name = "CreateAppError";
            readonly _tag = "CreateAppError";
            override readonly message =
              "GitHub is not connected, so there is nothing to build an app with.";
          })() as never,
        ),
    });
    return withContext(
      Effect.gen(function* () {
        const toolkit = yield* ConnectionsToolkit;
        const error = yield* Effect.flip(
          toolkit
            .handle("create_app", {
              appName: "my-app",
              visibility: "private",
              deploymentTarget: "production",
            })
            .pipe(Stream.unwrap, Stream.runCollect),
        );
        // The service's sentence, not a rewrite of it: the bot is told what
        // to say to the owner and that it cannot fix this itself.
        expect(text(error)).toContain("GitHub is not connected");
      }),
    ).pipe(Effect.provide(layer));
  });
});
