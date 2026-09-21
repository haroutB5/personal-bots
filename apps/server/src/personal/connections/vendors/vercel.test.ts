import { ConnectionId } from "@t3tools/contracts";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { operationsForVendor } from "../operations.ts";
import type { VendorHttp, VendorHttpRequest, VendorHttpResponse } from "./vendorHttp.ts";
import { makeVercelAdapter } from "./vercel.ts";

const TOKEN = "vercel_fake_TOKEN_value_0123456789";
const credentials = { accessToken: Redacted.make(TOKEN) };
const TEAM = { accountId: "u1", accountName: "harout", teamId: "team_abc", teamName: "Harout" };

/** One connection stands for the account under test. */
const CONNECTION = ConnectionId.make("connection-under-test");

const text = (value: unknown) =>
  NodeUtil.inspect(value, { depth: null, breakLength: Infinity, maxStringLength: null });

interface Route {
  readonly status?: number;
  readonly body?: unknown;
}

const harness = (routes: Readonly<Record<string, Route>>) => {
  const requests: Array<VendorHttpRequest> = [];
  const http: VendorHttp = (request) =>
    Effect.sync((): VendorHttpResponse => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url}`];
      if (route === undefined) {
        return {
          status: 599,
          body: { error: { message: `no route for ${request.method} ${request.url}` } },
          headers: {},
        };
      }
      return { status: route.status ?? 200, body: route.body ?? null, headers: {} };
    });
  return { requests, adapter: makeVercelAdapter(http) };
};

describe("vercel adapter", () => {
  it.effect("speaks exactly the vendor shape every vercel operation was reviewed against", () =>
    Effect.gen(function* () {
      const { adapter } = harness({});
      for (const operation of operationsForVendor("vercel")) {
        const spoken = yield* adapter.vendorSchema(operation.operationId);
        expect(spoken, operation.operationId).toBe(operation.reviewedVendorSchema);
      }
      expect(operationsForVendor("vercel").length).toBeGreaterThan(0);
    }),
  );

  it.effect("resolves the single team a scoped token can reach", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.vercel.com/v2/user": { body: { user: { id: "u1", username: "harout" } } },
        "GET https://api.vercel.com/v2/teams?limit=20": {
          body: { teams: [{ id: "team_abc", name: "Harout", slug: "harouts-projects" }] },
        },
      });
      const validation = yield* adapter.validate(credentials);
      expect(validation.account).toEqual(TEAM);
      expect(validation.verifiedCapabilities).toContain("vercel.create_deployment");
      expect(text(requests.map((request) => [request.url, request.body]))).not.toContain(TOKEN);
    }),
  );

  it.effect("treats a token with no team as the personal account", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.vercel.com/v2/user": { body: { user: { id: "u1", username: "harout" } } },
        "GET https://api.vercel.com/v2/teams?limit=20": { body: { teams: [] } },
      });
      const validation = yield* adapter.validate(credentials);
      expect(validation.account).toMatchObject({ teamId: null, teamName: null });
    }),
  );

  it.effect("refuses a token that reaches several teams rather than picking one", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.vercel.com/v2/user": { body: { user: { id: "u1", username: "harout" } } },
        "GET https://api.vercel.com/v2/teams?limit=20": {
          body: {
            teams: [
              { id: "team_a", name: "Alpha" },
              { id: "team_b", name: "Beta" },
            ],
          },
        },
      });
      const error = yield* Effect.flip(adapter.validate(credentials));
      // Every later call would have to guess a scope, and the wrong guess
      // deploys someone else's project.
      expect(error.detail).toContain("Alpha");
      expect(error.detail).toContain("Beta");
      expect(error.unauthorized).toBeUndefined();
    }),
  );

  it.effect("marks a rejected token as unauthorized", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.vercel.com/v2/user": {
          status: 403,
          body: { error: { message: "Not authorized" } },
        },
      });
      const error = yield* Effect.flip(adapter.validate(credentials));
      expect(error.unauthorized).toBe(true);
    }),
  );

  it.effect("scopes every call to the team the connection was validated against", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.vercel.com/v9/projects?limit=100&teamId=team_abc": {
          body: { projects: [{ id: "prj_1", name: "hbots-demo", framework: "nextjs" }] },
        },
      });
      const result = yield* adapter.execute({
        operationId: "vercel.list_projects",
        arguments: {},
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: TEAM,
      });
      expect(result).toEqual({
        projects: [{ project: "hbots-demo", projectId: "prj_1", framework: "nextjs" }],
      });
      expect(requests[0]?.url).toContain("teamId=team_abc");
    }),
  );

  it.effect("leaves the team out entirely for a personal account", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.vercel.com/v9/projects?limit=100": { body: { projects: [] } },
      });
      yield* adapter.execute({
        operationId: "vercel.list_projects",
        arguments: {},
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: { ...TEAM, teamId: null, teamName: null },
      });
      expect(requests[0]?.url).not.toContain("teamId");
    }),
  );

  it.effect("creates a project linked to the GitHub repository it was given", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "POST https://api.vercel.com/v10/projects?teamId=team_abc": {
          body: { id: "prj_1", name: "hbots-demo", framework: "nextjs" },
        },
      });
      const result = yield* adapter.execute({
        operationId: "vercel.create_project",
        arguments: {
          name: "hbots-demo",
          framework: "nextjs",
          githubRepository: "haroutB5/hbots-demo",
        },
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: TEAM,
      });
      expect(requests[0]?.body).toEqual({
        name: "hbots-demo",
        framework: "nextjs",
        gitRepository: { type: "github", repo: "haroutB5/hbots-demo" },
      });
      expect(result).toEqual({
        project: "hbots-demo",
        projectId: "prj_1",
        framework: "nextjs",
      });
    }),
  );

  it.effect("sets environment variables on exactly the named target and echoes only names", () =>
    Effect.gen(function* () {
      const secret = "postgres://user:hunter2@db.example.com/app";
      const { adapter, requests } = harness({
        "POST https://api.vercel.com/v10/projects/hbots-demo/env?upsert=true&teamId=team_abc": {
          body: { created: [{ id: "env_1", key: "DATABASE_URL" }] },
        },
      });
      const result = yield* adapter.execute({
        operationId: "vercel.set_environment_variables",
        arguments: {
          project: "hbots-demo",
          target: "production",
          variables: [{ key: "DATABASE_URL", value: secret }],
        },
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: TEAM,
      });
      expect(requests[0]?.body).toEqual([
        {
          key: "DATABASE_URL",
          value: secret,
          type: "encrypted",
          target: ["production"],
        },
      ]);
      // One target per call, and the value never comes back out.
      expect(result).toEqual({
        project: "hbots-demo",
        target: "production",
        keys: ["DATABASE_URL"],
      });
      expect(text(result)).not.toContain("hunter2");
    }),
  );

  it.effect("deploys the named ref of the project's own linked repository", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.vercel.com/v9/projects/hbots-demo?teamId=team_abc": {
          body: {
            id: "prj_1",
            name: "hbots-demo",
            link: { type: "github", repoId: 12345, org: "haroutB5", repo: "hbots-demo" },
          },
        },
        "POST https://api.vercel.com/v13/deployments?teamId=team_abc": {
          body: { id: "dpl_1", url: "hbots-demo-abc.vercel.app", target: "production" },
        },
      });
      const result = yield* adapter.execute({
        operationId: "vercel.create_deployment",
        arguments: { project: "hbots-demo", target: "production", gitRef: "main" },
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: TEAM,
      });
      expect(requests[1]?.body).toEqual({
        name: "hbots-demo",
        project: "prj_1",
        target: "production",
        gitSource: { type: "github", repoId: 12345, ref: "main" },
      });
      expect(result).toEqual({
        deploymentId: "dpl_1",
        url: "https://hbots-demo-abc.vercel.app",
        target: "production",
      });
    }),
  );

  it.effect("refuses to deploy a project with no repository linked to it", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.vercel.com/v9/projects/hbots-demo?teamId=team_abc": {
          body: { id: "prj_1", name: "hbots-demo", link: null },
        },
      });
      const error = yield* Effect.flip(
        adapter.execute({
          operationId: "vercel.create_deployment",
          arguments: { project: "hbots-demo", target: "production", gitRef: "main" },
          credentials,
          connectionId: CONNECTION,
          settings: { whatsappDailySendCap: null },
          account: TEAM,
        }),
      );
      expect(error.detail).toContain("not linked");
      // Nothing was posted: a deployment we cannot describe is not attempted.
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }),
  );

  it.effect("keeps the token out of every failure it reports", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "POST https://api.vercel.com/v10/projects?teamId=team_abc": {
          status: 409,
          body: { error: { message: "A project with this name already exists" } },
        },
      });
      const error = yield* Effect.flip(
        adapter.execute({
          operationId: "vercel.create_project",
          arguments: { name: "hbots-demo", framework: null, githubRepository: null },
          credentials,
          connectionId: CONNECTION,
          settings: { whatsappDailySendCap: null },
          account: TEAM,
        }),
      );
      expect(error.detail).toContain("already exists");
      expect(text(error)).not.toContain(TOKEN);
    }),
  );
});
