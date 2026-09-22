import { describe, expect, it } from "@effect/vitest";
import type { CreateAppPlan } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Operations from "../operations.ts";
import { createAppDataStorePlan, type CreateAppDataStoreKind } from "./dataStores.ts";
import { buildCreateAppPlan, planCovers } from "./plan.ts";
import { STATIC_APP_TEMPLATE } from "./template.ts";

/**
 * What a store's step will really ask the gateway for, checked against the
 * plan that authorizes it.
 *
 * These two have to agree exactly or a run creates a database and is then
 * refused when it tries to hand the app its credentials: the worst possible
 * place to stop, because the resource exists and the app cannot reach it.
 */
const prepare = (operationId: string, args: unknown) =>
  Operations.findOperation(operationId).pipe(
    Option.map((operation) => operation.prepare(args)),
    Option.getOrThrow,
  );

const planWith = (kinds: ReadonlyArray<CreateAppDataStoreKind>): CreateAppPlan => {
  const result = buildCreateAppPlan({
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
    dataStores: kinds.map((kind) =>
      createAppDataStorePlan({
        kind,
        appName: "my-app",
        vercelProject: "my-app",
        environmentTargets: ["production"],
      }),
    ),
  });
  if (result._tag === "Failure") throw new Error(result.failure);
  return result.success;
};

const expectCovered = (plan: CreateAppPlan, operationId: string, args: unknown) =>
  Effect.gen(function* () {
    const prepared = yield* prepare(operationId, args);
    const coverage = planCovers(plan, {
      operationId,
      targetResources: prepared.targetResources,
    });
    expect(coverage.covered, `${operationId}: ${coverage.reason ?? ""}`).toBe(true);
  });

describe("create_app data stores", () => {
  it.effect("covers every resource the Postgres step will actually touch", () => {
    const plan = planWith(["postgres"]);
    return Effect.gen(function* () {
      yield* expectCovered(plan, "neon.create_project", {
        name: "my-app",
        regionId: "aws-eu-west-2",
      });
      yield* expectCovered(plan, "neon.attach_connection_string_to_vercel", {
        project: "my-app",
        projectId: "shiny-wind-028834",
        branch: null,
        database: "neondb",
        role: "neondb_owner",
        pooled: true,
        vercelProject: "my-app",
        target: "production",
        variableName: "DATABASE_URL",
      });
    });
  });

  it.effect("covers every resource the Redis step will actually touch", () => {
    const plan = planWith(["redis"]);
    return Effect.gen(function* () {
      yield* expectCovered(plan, "upstash.create_redis_database", {
        name: "my-app",
        primaryRegion: "eu-west-1",
        plan: "free",
      });
      yield* expectCovered(plan, "upstash.attach_rest_credentials_to_vercel", {
        // The id only exists once the database does. If coverage keyed on it,
        // this call would be refused after the database had been created.
        databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
        database: "my-app",
        vercelProject: "my-app",
        target: "production",
        urlVariableName: "KV_REST_API_URL",
        tokenVariableName: "KV_REST_API_TOKEN",
      });
    });
  });

  it("does not license a store's operations against another account's resources", () => {
    const coverage = planCovers(planWith(["postgres"]), {
      operationId: "neon.create_project",
      targetResources: ["neon:project:someone-elses-app"],
    });

    expect(coverage.covered).toBe(false);
  });

  it("names the free tier in words the owner reads, for both stores", () => {
    for (const store of planWith(["postgres", "redis"]).dataStores) {
      expect(store.costCeiling.toLowerCase()).toContain("free");
    }
  });

  it.effect("asks for regions the operations were reviewed against", () => {
    const [postgres, redis] = planWith(["postgres", "redis"]).dataStores;
    return Effect.gen(function* () {
      // A region outside the allowlist fails at the operation, which would
      // strand a run mid-plan rather than at the card.
      yield* prepare("neon.create_project", { name: "my-app", regionId: postgres!.region });
      yield* prepare("upstash.create_redis_database", {
        name: "my-app",
        primaryRegion: redis!.region,
        plan: "free",
      });
    });
  });

  it("puts a store's environment keys in the plan the owner approves", () => {
    const plan = planWith(["postgres", "redis"]);

    expect(plan.environmentKeys).toEqual(
      expect.arrayContaining(["DATABASE_URL", "KV_REST_API_URL", "KV_REST_API_TOKEN"]),
    );
  });
});
