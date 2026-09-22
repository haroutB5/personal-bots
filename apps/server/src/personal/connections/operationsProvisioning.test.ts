import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Operations from "./operations.ts";

/**
 * The Neon and Upstash provisioning operations added in Milestone 4.
 *
 * Kept beside `operations.test.ts` rather than inside it so the vertical
 * slice's gate and this one name different files.
 */

const prepare = (operationId: string, args: unknown) =>
  Operations.findOperation(operationId).pipe(
    Option.map((operation) => operation.prepare(args)),
    Option.getOrThrow,
  );

const operation = (operationId: string) =>
  Operations.findOperation(operationId).pipe(Option.getOrThrow);

describe("neon provisioning operations", () => {
  it.effect("accepts a role name with an underscore, which Neon's default role has", () =>
    Effect.gen(function* () {
      // `neondb_owner` is what Neon names the role it creates with a project.
      // A pattern that excluded it would refuse every default Neon database.
      const prepared = yield* prepare("neon.attach_connection_string_to_vercel", {
        project: "hbots-demo",
        projectId: "shiny-wind-028834",
        branch: null,
        database: "neondb",
        role: "neondb_owner",
        pooled: true,
        vercelProject: "hbots-demo",
        target: "production",
        variableName: "DATABASE_URL",
      });
      expect(prepared.arguments["role"]).toBe("neondb_owner");
    }),
  );

  it.effect("refuses a region it was not reviewed against rather than passing it on", () =>
    Effect.gen(function* () {
      const good = yield* prepare("neon.create_project", {
        name: "hbots-demo",
        regionId: "aws-eu-west-2",
      });
      expect(good.risk).toMatchObject({ approvalRequired: true, reason: "account_write" });
      expect(good.risk.summary).toContain("aws-eu-west-2");

      const unknown = yield* Effect.flip(
        prepare("neon.create_project", { name: "hbots-demo", regionId: "aws-mars-1" }),
      );
      expect(unknown._tag).toBe("ConnectionOperationArgumentError");
    }),
  );

  it.effect("makes a project deletion read as irreversible and name what it destroys", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare("neon.delete_project", {
        project: "shiny-wind-028834",
        name: "hbots-demo",
      });
      expect(prepared.risk.approvalRequired).toBe(true);
      expect(prepared.risk.summary).toContain("hbots-demo");
      expect(prepared.risk.summary).toContain("cannot be undone");
      // The id is what gets deleted, so the approval binds to the id and the
      // owner reads the name; the adapter proves the two are the same thing.
      expect(prepared.targetResources).toContain("neon:project:shiny-wind-028834");
    }),
  );

  it.effect("binds a credential transfer to both ends and never quotes a value", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare("neon.attach_connection_string_to_vercel", {
        project: "hbots-demo",
        projectId: "shiny-wind-028834",
        branch: "br-main-1",
        database: "neondb",
        role: "neondb_owner",
        pooled: true,
        vercelProject: "hbots-demo",
        target: "production",
        variableName: "DATABASE_URL",
      });
      // Production configuration is what the live site runs with.
      expect(prepared.risk.reason).toBe("deployment");
      expect(prepared.risk.summary).toContain("DATABASE_URL");
      expect(prepared.risk.summary).toContain("never shown");
      // The owner reads both the name and the id Neon will be asked about.
      expect(prepared.risk.summary).toContain("hbots-demo (shiny-wind-028834)");
      // A plan names the project before it exists, so coverage is by name.
      expect(prepared.targetResources).not.toContain("neon:project:shiny-wind-028834");
      expect(prepared.targetResources).toEqual(
        expect.arrayContaining([
          "neon:project:hbots-demo",
          "neon:database:neondb",
          "vercel:project:hbots-demo",
          "vercel:target:production",
          "vercel:env:production:DATABASE_URL",
        ]),
      );
      // There is no argument a secret could be put in: the value is fetched
      // server-side from identifiers, never handed over by the model.
      expect(Object.keys(prepared.arguments).toSorted()).toEqual([
        "branch",
        "database",
        "pooled",
        "project",
        "projectId",
        "role",
        "target",
        "variableName",
        "vercelProject",
      ]);
      expect(operation("neon.attach_connection_string_to_vercel").resultFields).toEqual([
        "vercelProject",
        "target",
        "keys",
      ]);
    }),
  );

  it("names the second connection a transfer needs, so the gateway can resolve it", () => {
    expect(operation("neon.attach_connection_string_to_vercel").secondaryVendorId).toBe("vercel");
    expect(operation("upstash.attach_rest_credentials_to_vercel").secondaryVendorId).toBe("vercel");
    // A single-vendor operation states none, and the gateway resolves nothing.
    expect(operation("neon.create_project").secondaryVendorId).toBeNull();
  });
});

describe("upstash provisioning operations", () => {
  it.effect("names the plan in the summary, because it is what the database costs", () =>
    Effect.gen(function* () {
      const free = yield* prepare("upstash.create_redis_database", {
        name: "hbots_demo_cache",
        primaryRegion: "eu-west-1",
        plan: "free",
      });
      expect(free.risk.summary).toContain("free");
      expect(free.risk.summary).toContain("eu-west-1");

      const paid = yield* prepare("upstash.create_redis_database", {
        name: "hbots_demo_cache",
        primaryRegion: "eu-west-1",
        plan: "payg",
      });
      expect(paid.risk.summary).toContain("billed");
    }),
  );

  it.effect("binds a REST credential transfer to both variable names", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare("upstash.attach_rest_credentials_to_vercel", {
        databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
        database: "hbots_demo_cache",
        vercelProject: "hbots-demo",
        target: "preview",
        urlVariableName: "UPSTASH_REDIS_REST_URL",
        tokenVariableName: "UPSTASH_REDIS_REST_TOKEN",
      });
      expect(prepared.risk.reason).toBe("account_write");
      expect(prepared.targetResources).toEqual(
        expect.arrayContaining([
          // The name, not the id: a create_app plan is written before the
          // database exists and could never name an id.
          "upstash:database:hbots_demo_cache",
          "vercel:env:preview:UPSTASH_REDIS_REST_URL",
          "vercel:env:preview:UPSTASH_REDIS_REST_TOKEN",
        ]),
      );
    }),
  );

  it.effect("refuses an environment variable name that is a shell fragment", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        prepare("upstash.attach_rest_credentials_to_vercel", {
          databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
          database: "hbots_demo_cache",
          vercelProject: "hbots-demo",
          target: "preview",
          urlVariableName: "UPSTASH_REDIS_REST_URL; rm -rf /",
          tokenVariableName: "UPSTASH_REDIS_REST_TOKEN",
        }),
      );
      expect(error._tag).toBe("ConnectionOperationArgumentError");
    }),
  );
});
