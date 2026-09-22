import type {
  CreateAppDataStorePlan,
  CreateAppDeploymentTarget,
  CreateAppPlan,
  CreateAppRun,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { AppHealthCheck } from "./healthCheck.ts";
import { NEON_DEFAULT_DATABASE } from "./dataStores.ts";
import { materializeTemplate, resolveTemplate, validateTemplateFiles } from "./template.ts";

/**
 * The steps of `create_app`, and the shape any future step must have.
 *
 * ## Ordering, and why a push comes before the project
 *
 * Pushing to a repository a host is already watching deploys it. That is a
 * side effect the run does not control and cannot see, and it would race the
 * deployment the plan actually approved. So the repository is created and
 * filled *before* the Vercel project links to it: at push time nothing is
 * watching, so nothing can ship on its own, and the only deployment of the run
 * is the one the plan named.
 *
 * ## Retry, honestly
 *
 * Nothing here is exactly-once. A crash between "the provider created it" and
 * "the server recorded it" is a real state, and each step says what may be
 * done about it:
 *
 * - `reconcile` — the step creates something with a name. Before any retry it
 *   asks the provider what exists under the plan's name in the connected
 *   account, and adopts it rather than making a second one.
 * - `repeatable` — repeating converges on the same state (a push of a fixed
 *   file set, an upsert of the same variables), and nothing it creates can be
 *   duplicated. No reconcile is needed, and none is pretended.
 * - `manual` — the outcome is ambiguous and the provider offers nothing to
 *   reconcile against. The run stops and says so. It never guesses, and it
 *   never deletes anything to tidy up.
 */

export class CreateAppStepError extends Schema.TaggedError<CreateAppStepError>()(
  "CreateAppStepError",
  {
    reason: Schema.String,
    /** The provider was asked and may have acted; see PersonalConnectionGatewayError. */
    ambiguous: Schema.optionalKey(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface CreateAppStepOutcome {
  /** The identity the provider gave what this step made, if it made one. */
  readonly remoteId: string | null;
  /** Safe facts, persisted and shown to the owner. Never a value or a token. */
  readonly receipt: Readonly<Record<string, string>>;
  /**
   * Values for planned environment keys. Kept in the run's memory for the
   * length of the process and handed to the next step; never persisted, never
   * logged, never returned to a model.
   */
  readonly secrets?: Readonly<Record<string, Redacted.Redacted<string>>>;
  /** The app's public URL, once a step knows it. */
  readonly appUrl?: string;
}

export interface CreateAppStepContext {
  readonly plan: CreateAppPlan;
  readonly run: CreateAppRun;
  /** What earlier steps recorded, by step id. Survives a restart. */
  readonly receipts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** What earlier steps produced in this process. Does not survive a restart. */
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  /**
   * One gateway call, authorized by the approved plan. The gateway still
   * validates the arguments, re-reads the connection and refuses anything the
   * plan does not cover; this is not a way around it.
   */
  readonly call: (request: {
    readonly operationId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    /**
     * Secret values this call is deliberately carrying *as arguments* — a
     * store's connection string on its way into a host environment. The
     * gateway scrubs the connection's own credentials from a vendor error by
     * default; a vendor that quotes our request body back would otherwise
     * print these, so they are named here and scrubbed with them.
     */
    readonly scrub?: ReadonlyArray<Redacted.Redacted<string>>;
  }) => Effect.Effect<Readonly<Record<string, unknown>>, CreateAppStepError>;
  readonly health: AppHealthCheck["Service"];
}

export type CreateAppRetryPolicy = "reconcile" | "repeatable" | "manual";

export interface CreateAppStepDefinition {
  readonly stepId: string;
  /** Server-authored; the owner reads this, never anything a bot wrote. */
  readonly title: string;
  readonly retryPolicy: CreateAppRetryPolicy;
  /**
   * What exists already under the plan's own names, in the connected account.
   * Called only for a step that was in flight when the process died, and its
   * answer is adopted rather than recreated. `None` means nothing was found,
   * which for a `reconcile` step is what makes a retry safe.
   */
  readonly reconcile: (
    context: CreateAppStepContext,
  ) => Effect.Effect<Option.Option<CreateAppStepOutcome>, CreateAppStepError>;
  readonly execute: (
    context: CreateAppStepContext,
  ) => Effect.Effect<CreateAppStepOutcome, CreateAppStepError>;
  /**
   * Finishes a step whose resource `reconcile` adopted. A step that does two
   * things (create a store, then write its credential into Vercel) is found
   * by the first alone, so without this a retry adopts the store and never
   * writes the credential, and the run reports an app that cannot reach its
   * database as live. Must be safe to repeat.
   */
  readonly completeAdopted?: (
    context: CreateAppStepContext,
    adopted: CreateAppStepOutcome,
  ) => Effect.Effect<CreateAppStepOutcome, CreateAppStepError>;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const nothingToReconcile = () => Effect.succeed(Option.none<CreateAppStepOutcome>());

/** 1. The scaffold, checked here and nowhere else in the run. */
const ScaffoldStep: CreateAppStepDefinition = {
  stepId: "scaffold",
  title: "Check the app template",
  // Pure and local: running it twice reads the same files and concludes the
  // same thing.
  retryPolicy: "repeatable",
  reconcile: nothingToReconcile,
  execute: (context) =>
    Effect.gen(function* () {
      const template = resolveTemplate(context.plan.template);
      if (Option.isNone(template)) {
        // A plan pinned to a scaffold this build does not have is a plan this
        // build cannot carry out. Substituting the nearest one would be
        // executing something the owner did not read.
        return yield* new CreateAppStepError({
          reason: `This build does not have the template ${context.plan.template.revision} the plan was approved with. Nothing ran.`,
        });
      }
      const files = materializeTemplate(template.value, { appName: context.plan.appName });
      const problems = validateTemplateFiles(files, context.plan.healthCheck.marker);
      if (problems.length > 0) {
        return yield* new CreateAppStepError({
          reason: `The app template is not usable: ${problems.join(" ")}`,
        });
      }
      return {
        remoteId: null,
        receipt: {
          template: context.plan.template.revision,
          files: String(files.length),
        },
      };
    }),
};

/** 2. The repository. Nothing is watching it yet, by design. */
const RepositoryStep: CreateAppStepDefinition = {
  stepId: "github.repository",
  title: "Create the GitHub repository",
  retryPolicy: "reconcile",
  reconcile: (context) =>
    context.call({ operationId: "github.list_repositories", arguments: {} }).pipe(
      Effect.map((result) => {
        const rows = result["repositories"];
        const found = (Array.isArray(rows) ? rows : []).map(asRecord).find(
          (row) =>
            // Name *and* owner *and* the visibility the plan asked for.
            // A repository that matches the name but not the plan is
            // somebody else's, and adopting it would be worse than failing.
            asString(row["repository"]) === context.plan.github.repository &&
            asString(row["visibility"]) === context.plan.github.visibility,
        );
        return found === undefined
          ? Option.none<CreateAppStepOutcome>()
          : Option.some<CreateAppStepOutcome>({
              remoteId: context.plan.github.repository,
              receipt: {
                repository: context.plan.github.repository,
                htmlUrl: asString(found["htmlUrl"]),
              },
            });
      }),
    ),
  execute: (context) =>
    context
      .call({
        operationId: "github.create_repository",
        arguments: {
          name: context.plan.github.repositoryName,
          visibility: context.plan.github.visibility,
        },
      })
      .pipe(
        Effect.map((result) => ({
          remoteId: asString(result["repository"]) || context.plan.github.repository,
          receipt: {
            repository: asString(result["repository"]) || context.plan.github.repository,
            htmlUrl: asString(result["htmlUrl"]),
          },
        })),
      ),
};

/** 3. The first commit, while no host is linked to the repository. */
const PushStep: CreateAppStepDefinition = {
  stepId: "github.push",
  title: "Push the app's first commit",
  // The file set is fixed by the pinned template, so a repeat pushes the same
  // tree to the same branch and converges. It creates no named resource, and
  // at this point in the run nothing is linked to the repository, so a repeat
  // cannot ship anything either.
  retryPolicy: "repeatable",
  reconcile: nothingToReconcile,
  execute: (context) =>
    Effect.gen(function* () {
      const template = resolveTemplate(context.plan.template);
      if (Option.isNone(template)) {
        return yield* new CreateAppStepError({
          reason: `This build does not have the template ${context.plan.template.revision} the plan was approved with. Nothing ran.`,
        });
      }
      const files = materializeTemplate(template.value, { appName: context.plan.appName });
      const result = yield* context.call({
        operationId: "github.push_files",
        arguments: {
          repository: context.plan.github.repository,
          branch: context.plan.github.branch,
          files: files.map((file) => ({ path: file.path, contents: file.contents })),
        },
      });
      return {
        remoteId: asString(result["commitSha"]),
        receipt: {
          repository: context.plan.github.repository,
          branch: context.plan.github.branch,
          commitSha: asString(result["commitSha"]),
          files: String(files.length),
        },
      };
    }),
};

/** 4. The project, linked to a repository that already has its commit. */
const ProjectStep: CreateAppStepDefinition = {
  stepId: "vercel.project",
  title: "Create the Vercel project",
  retryPolicy: "reconcile",
  reconcile: (context) =>
    context.call({ operationId: "vercel.list_projects", arguments: {} }).pipe(
      Effect.map((result) => {
        const rows = result["projects"];
        const found = (Array.isArray(rows) ? rows : [])
          .map(asRecord)
          .find((row) => asString(row["project"]) === context.plan.vercel.project);
        return found === undefined
          ? Option.none<CreateAppStepOutcome>()
          : Option.some<CreateAppStepOutcome>({
              remoteId: asString(found["projectId"]),
              receipt: {
                project: context.plan.vercel.project,
                projectId: asString(found["projectId"]),
              },
            });
      }),
    ),
  execute: (context) =>
    context
      .call({
        operationId: "vercel.create_project",
        arguments: {
          name: context.plan.vercel.project,
          framework: context.plan.vercel.framework,
          githubRepository: context.plan.github.repository,
        },
      })
      .pipe(
        Effect.map((result) => ({
          remoteId: asString(result["projectId"]),
          receipt: {
            project: asString(result["project"]) || context.plan.vercel.project,
            projectId: asString(result["projectId"]),
          },
        })),
      ),
};

/** 5. Configuration, before the deployment that will run with it. */
const EnvironmentStep: CreateAppStepDefinition = {
  stepId: "vercel.environment",
  title: "Set the environment variables",
  // The vendor call is an upsert of the same names to the same values.
  retryPolicy: "repeatable",
  reconcile: nothingToReconcile,
  execute: (context) =>
    Effect.gen(function* () {
      const template = resolveTemplate(context.plan.template);
      if (Option.isNone(template)) {
        return yield* new CreateAppStepError({
          reason: `This build does not have the template ${context.plan.template.revision} the plan was approved with. Nothing ran.`,
        });
      }
      const values = new Map<string, string>(
        template.value.environment.map((entry) => [entry.key, entry.value]),
      );
      // A data store's connection string arrives as a Redacted and is read
      // exactly once, here, into the argument the gateway hands the adapter.
      // It is named to `scrub` in the same breath, so a vendor that quotes the
      // request back cannot print it into a log or an error.
      const secret = Object.values(context.secrets);
      for (const [key, value] of Object.entries(context.secrets)) {
        values.set(key, Redacted.value(value));
      }
      // A store that moves its own credential provider-to-provider has already
      // written its keys into this environment, and their values were never in
      // this process to write. Requiring them here would fail a run whose
      // variables are, in fact, set.
      const storeKeys = new Set(context.plan.dataStores.flatMap((store) => store.environmentKeys));
      const ownKeys = context.plan.environmentKeys.filter((key) => !storeKeys.has(key));
      const missing = ownKeys.filter((key) => !values.has(key));
      if (missing.length > 0) {
        return yield* new CreateAppStepError({
          reason: `The plan names ${missing.join(", ")}, and no step produced ${missing.length === 1 ? "it" : "them"}. Nothing was set.`,
        });
      }
      const variables = ownKeys.map((key) => ({ key, value: values.get(key) ?? "" }));
      if (variables.length === 0) {
        return { remoteId: null, receipt: { keys: "", targets: "" } };
      }
      for (const target of context.plan.deployment.environmentTargets) {
        yield* context.call({
          operationId: "vercel.set_environment_variables",
          arguments: { project: context.plan.vercel.project, target, variables },
          scrub: secret,
        });
      }
      return {
        remoteId: null,
        // Names only. The values are the point of the call and never leave it.
        receipt: {
          project: context.plan.vercel.project,
          targets: context.plan.deployment.environmentTargets.join(", "),
          keys: context.plan.environmentKeys.join(", "),
        },
      };
    }),
};

/** 6. The deployment the plan named, and the only one of the run. */
const DeploymentStep: CreateAppStepDefinition = {
  stepId: "vercel.deployment",
  title: "Deploy the app",
  // A deployment has no name to look it up by, and this build has no read
  // operation that lists them, so an interrupted deployment is ambiguous and
  // stays ambiguous. Firing a second one to find out would be exactly the
  // blind retry this design refuses. See HANDOFF for the read operation that
  // would turn this into `reconcile`.
  retryPolicy: "manual",
  reconcile: nothingToReconcile,
  execute: (context) =>
    context
      .call({
        operationId: "vercel.create_deployment",
        arguments: {
          project: context.plan.vercel.project,
          target: context.plan.deployment.target,
          gitRef: context.plan.github.branch,
        },
      })
      .pipe(
        Effect.map((result) => {
          // The public production address when Vercel has one: the
          // per-deployment host is behind Deployment Protection.
          const productionUrl = asString(result["productionUrl"]);
          return {
            remoteId: asString(result["deploymentId"]),
            appUrl: productionUrl || asString(result["url"]),
            receipt: {
              deploymentId: asString(result["deploymentId"]),
              url: asString(result["url"]),
              target: asString(result["target"]) || context.plan.deployment.target,
              ...(productionUrl === "" ? {} : { productionUrl }),
            },
          };
        }),
      ),
};

/** 7. The only thing that counts as done. */
const HealthStep: CreateAppStepDefinition = {
  stepId: "health",
  title: "Check the app answers",
  retryPolicy: "repeatable",
  reconcile: nothingToReconcile,
  execute: (context) =>
    Effect.gen(function* () {
      // The production domain first: the per-deployment URL answers a
      // protected deployment with Vercel's login page, never the app.
      const deployment = context.receipts["vercel.deployment"];
      const url = deployment?.["productionUrl"] || deployment?.["url"] || context.run.appUrl;
      if (url === undefined || url === null || url.length === 0) {
        return yield* new CreateAppStepError({
          reason: "The deployment did not report a URL, so there is nothing to check.",
        });
      }
      const outcome = yield* context.health.awaitHealthy({
        url,
        path: context.plan.healthCheck.path,
        marker: context.plan.healthCheck.marker,
      });
      if (outcome._tag === "unhealthy") {
        // The deploy API said yes. The app did not. The run is not complete,
        // and everything it built stays exactly where it is.
        return yield* new CreateAppStepError({
          reason: `The deployment was accepted but ${outcome.url} never answered as the app: after ${outcome.attempts} checks, ${outcome.reason}.`,
        });
      }
      return {
        remoteId: null,
        appUrl: outcome.url,
        receipt: {
          url: outcome.url,
          status: String(outcome.status),
          attempts: String(outcome.attempts),
        },
      };
    }),
};

/**
 * ===========================================================================
 * SEAM: data-store steps (Milestone 4)
 * ===========================================================================
 *
 * A data-store vendor plugs in here and nowhere else. To add one:
 *
 * 1. Write a `CreateAppDataStoreStepFactory` whose `build` returns a
 *    `CreateAppStepDefinition` for one planned store. Its `execute` returns
 *    the store's connection secrets under the plan's `environmentKeys` as
 *    `Redacted`, which the environment step then writes into Vercel without
 *    the value ever becoming text anywhere.
 * 2. Give it `retryPolicy: "reconcile"` and a `reconcile` that lists the
 *    vendor's resources and matches the plan's `resourceName` in the connected
 *    account. A store is a named, billable resource: a second one is the worst
 *    kind of duplicate.
 * 3. Add it to `DATA_STORE_STEP_FACTORIES`.
 *
 * Nothing else changes. The plan already carries each store's tier, region,
 * cost ceiling, operation ids and target resources, and `planCovers` already
 * authorizes exactly those and nothing else.
 */
export interface CreateAppDataStoreStepFactory {
  readonly vendorId: PersonalConnectionVendorId;
  readonly build: (store: CreateAppDataStorePlan) => CreateAppStepDefinition;
}

/**
 * Both stores move their own credential into Vercel with the server-side
 * transfer operations rather than handing the value back through `secrets`.
 * The value is then never an argument, never in this process, and never in a
 * scrub list that has to be right: there is no channel to get it wrong in.
 * The environment step knows to skip the keys these steps write.
 */
const attachTargets = (plan: CreateAppPlan): ReadonlyArray<CreateAppDeploymentTarget> =>
  plan.deployment.environmentTargets;

/**
 * Writes one Neon database's connection string into every target. An upsert
 * on Vercel's side, so running it again converges rather than duplicating.
 */
const attachNeon = (
  context: CreateAppStepContext,
  store: CreateAppDataStorePlan,
  database: string,
  role: string,
) =>
  Effect.gen(function* () {
    const variableName = store.environmentKeys[0];
    if (variableName === undefined) {
      return yield* new CreateAppStepError({
        reason: `The plan gives ${store.resourceName} no environment variable to fill, so the app would never reach it.`,
      });
    }
    for (const target of attachTargets(context.plan)) {
      yield* context.call({
        operationId: "neon.attach_connection_string_to_vercel",
        arguments: {
          project: store.resourceName,
          branch: null,
          database,
          role,
          pooled: true,
          vercelProject: context.plan.vercel.project,
          target,
          variableName,
        },
      });
    }
    return variableName;
  });

const NeonStoreStepFactory: CreateAppDataStoreStepFactory = {
  vendorId: "neon",
  build: (store) => ({
    stepId: store.stepId,
    title: store.title,
    // A database is a named, billable resource: a second one is the worst
    // kind of duplicate, so a retry looks before it creates.
    retryPolicy: "reconcile",
    reconcile: (context) =>
      context.call({ operationId: "neon.list_projects", arguments: {} }).pipe(
        Effect.map((result) => {
          const rows = result["projects"];
          const found = (Array.isArray(rows) ? rows : [])
            .map(asRecord)
            .find((row) => asString(row["project"]) === store.resourceName);
          return found === undefined
            ? Option.none<CreateAppStepOutcome>()
            : Option.some<CreateAppStepOutcome>({
                remoteId: asString(found["projectId"]),
                receipt: { project: store.resourceName, adopted: "yes" },
              });
        }),
      ),
    execute: (context) =>
      Effect.gen(function* () {
        const created = yield* context.call({
          operationId: "neon.create_project",
          arguments: { name: store.resourceName, regionId: store.region },
        });
        const database = asString(created["database"]) || NEON_DEFAULT_DATABASE;
        const role = asString(created["role"]);
        const variableName = yield* attachNeon(context, store, database, role);
        return {
          remoteId: asString(created["projectId"]),
          // Names only; the connection string never entered this process.
          receipt: { project: store.resourceName, database, keys: variableName },
        };
      }),
    // The list read that found the project does not say which database and
    // role it has. A project this run created has Neon's defaults: the
    // `neondb` database owned by `neondb_owner`. If that is wrong, Neon
    // refuses the attach and the run stops, rather than reporting live.
    completeAdopted: (context, adopted) =>
      attachNeon(context, store, NEON_DEFAULT_DATABASE, `${NEON_DEFAULT_DATABASE}_owner`).pipe(
        Effect.map((variableName) => ({
          ...adopted,
          receipt: { ...adopted.receipt, database: NEON_DEFAULT_DATABASE, keys: variableName },
        })),
      ),
  }),
};

/** Writes one Upstash database's REST URL and token into every target; an upsert. */
const attachUpstash = (
  context: CreateAppStepContext,
  store: CreateAppDataStorePlan,
  databaseId: string,
) =>
  Effect.gen(function* () {
    const [urlVariableName, tokenVariableName] = store.environmentKeys;
    if (urlVariableName === undefined || tokenVariableName === undefined) {
      return yield* new CreateAppStepError({
        reason: `The plan gives ${store.resourceName} fewer than the two environment variables a Redis client needs, so the app would never reach it.`,
      });
    }
    for (const target of attachTargets(context.plan)) {
      yield* context.call({
        operationId: "upstash.attach_rest_credentials_to_vercel",
        arguments: {
          databaseId,
          database: store.resourceName,
          vercelProject: context.plan.vercel.project,
          target,
          urlVariableName,
          tokenVariableName,
        },
      });
    }
    return `${urlVariableName}, ${tokenVariableName}`;
  });

const UpstashStoreStepFactory: CreateAppDataStoreStepFactory = {
  vendorId: "upstash",
  build: (store) => ({
    stepId: store.stepId,
    title: store.title,
    retryPolicy: "reconcile",
    reconcile: (context) =>
      context.call({ operationId: "upstash.list_databases", arguments: {} }).pipe(
        Effect.map((result) => {
          const rows = result["databases"];
          const found = (Array.isArray(rows) ? rows : [])
            .map(asRecord)
            .find((row) => asString(row["database"]) === store.resourceName);
          return found === undefined
            ? Option.none<CreateAppStepOutcome>()
            : Option.some<CreateAppStepOutcome>({
                remoteId: asString(found["databaseId"]),
                receipt: { database: store.resourceName, adopted: "yes" },
              });
        }),
      ),
    execute: (context) =>
      Effect.gen(function* () {
        const created = yield* context.call({
          operationId: "upstash.create_redis_database",
          arguments: {
            name: store.resourceName,
            primaryRegion: store.region,
            plan: store.tier === "free" ? "free" : "payg",
          },
        });
        const databaseId = asString(created["databaseId"]);
        const keys = yield* attachUpstash(context, store, databaseId);
        return {
          remoteId: databaseId,
          receipt: { database: store.resourceName, keys },
        };
      }),
    completeAdopted: (context, adopted) =>
      attachUpstash(context, store, adopted.remoteId ?? "").pipe(
        Effect.map((keys) => ({ ...adopted, receipt: { ...adopted.receipt, keys } })),
      ),
  }),
};

export const DATA_STORE_STEP_FACTORIES: ReadonlyArray<CreateAppDataStoreStepFactory> = [
  NeonStoreStepFactory,
  UpstashStoreStepFactory,
];

/**
 * The run's steps, in order. Data-store steps sit after the project and before
 * the environment: they produce the values the environment step writes, and
 * they must exist before the deployment that will read them.
 */
export const buildCreateAppSteps = (
  plan: CreateAppPlan,
  factories: ReadonlyArray<CreateAppDataStoreStepFactory> = DATA_STORE_STEP_FACTORIES,
): Effect.Effect<ReadonlyArray<CreateAppStepDefinition>, CreateAppStepError> =>
  Effect.gen(function* () {
    const stores: Array<CreateAppStepDefinition> = [];
    for (const store of plan.dataStores) {
      const factory = factories.find((entry) => entry.vendorId === store.vendorId);
      if (factory === undefined) {
        // The plan named a resource this build cannot provision. Carrying on
        // would deploy an app whose database was never created.
        return yield* new CreateAppStepError({
          reason: `This build cannot provision ${store.vendorId} resources, and the plan asks for ${store.resourceName}. Nothing ran.`,
        });
      }
      stores.push(factory.build(store));
    }
    return [
      ScaffoldStep,
      RepositoryStep,
      PushStep,
      ProjectStep,
      ...stores,
      ...(plan.environmentKeys.length === 0 ? [] : [EnvironmentStep]),
      DeploymentStep,
      HealthStep,
    ];
  });

export const CREATE_APP_CORE_STEPS = {
  ScaffoldStep,
  RepositoryStep,
  PushStep,
  ProjectStep,
  EnvironmentStep,
  DeploymentStep,
  HealthStep,
} as const;
