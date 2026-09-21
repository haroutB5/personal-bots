// @effect-diagnostics preferSchemaOverJson:off - quoting a vendor's own error body back, not decoding a known shape.
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type {
  ConnectionVendorAccount,
  ConnectionVendorAdapter,
  ConnectionVendorCall,
  ConnectionVendorError,
} from "../adapters.ts";
import {
  expectOk,
  isUnauthorizedStatus,
  vendorFailure,
  type VendorHttp,
  type VendorHttpRequest,
} from "./vendorHttp.ts";

/**
 * Vercel over its REST API.
 *
 * The REST API rather than Vercel's OAuth MCP server: that endpoint expects an
 * OAuth grant obtained through a callback URL, and hbots has no callback URL
 * to host and no registered app. A pasted token is not established as valid
 * auth there, so it would fail at the first call rather than at the connect
 * screen.
 *
 * The shapes are literals here rather than read from the operation catalog so
 * that the gateway's drift check compares two independent statements;
 * `vercel.test.ts` asserts they agree.
 */

const API = "https://api.vercel.com";

/**
 * Exported so an adapter that writes into a Vercel environment as the second
 * half of a server-side credential transfer can pin the Vercel half of its own
 * reviewed shape against this one. It still states its own literal; the test
 * that compares them is what makes a bump here fail there first.
 */
export const VERCEL_VENDOR_SCHEMAS: Readonly<Record<string, string>> = {
  "vercel.list_projects": "vercel/v9-projects@2026-09-20",
  "vercel.create_project": "vercel/v10-projects@2026-09-20",
  "vercel.set_environment_variables": "vercel/v10-project-env@2026-09-20",
  "vercel.create_deployment": "vercel/v13-deployments@2026-09-20",
};

const VENDOR_SCHEMAS = VERCEL_VENDOR_SCHEMAS;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Vercel scopes a request to a team by query parameter; a personal token sends none. */
const scoped = (path: string, account: ConnectionVendorAccount | null) => {
  const teamId = account?.teamId ?? null;
  if (teamId === null) return `${API}${path}`;
  return `${API}${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
};

/**
 * Writes encrypted environment variables to exactly one Vercel environment and
 * answers with the names only.
 *
 * Lives outside the adapter because it is also the second half of a
 * server-side credential transfer: an adapter for a provisioning vendor fetches
 * a secret and hands it here, so the value goes from one provider to the other
 * inside one call without ever becoming an operation argument or a result. It
 * takes `Redacted` values for the same reason the HTTP seam does — the
 * plaintext exists only where the request body is built.
 */
export const setVercelEnvironmentVariables = (input: {
  readonly http: VendorHttp;
  readonly operationId: string;
  readonly bearer: Redacted.Redacted<string>;
  readonly account: ConnectionVendorAccount | null;
  readonly project: string;
  readonly target: string;
  readonly variables: ReadonlyArray<{
    readonly key: string;
    readonly value: Redacted.Redacted<string>;
  }>;
}): Effect.Effect<ReadonlyArray<string>, ConnectionVendorError> =>
  input
    .http({
      operationId: input.operationId,
      method: "POST",
      url: scoped(
        `/v10/projects/${encodeURIComponent(input.project)}/env?upsert=true`,
        input.account,
      ),
      bearer: input.bearer,
      body: input.variables.map((variable) => ({
        key: variable.key,
        value: Redacted.value(variable.value),
        type: "encrypted",
        // Exactly the one environment the owner approved, never both.
        target: [input.target],
      })),
    })
    .pipe(
      Effect.flatMap((response) => expectOk(input.operationId, response)),
      // The reply repeats the values back; only the names leave this function.
      Effect.map(() => input.variables.map((variable) => variable.key)),
    );

export const makeVercelAdapter = (http: VendorHttp): ConnectionVendorAdapter => {
  const token = (call: {
    readonly operationId: string;
    readonly credentials: ConnectionVendorCall["credentials"];
  }) => {
    const value = call.credentials["accessToken"];
    return value === undefined
      ? Effect.fail(
          vendorFailure(call.operationId, "The Vercel connection has no access token stored."),
        )
      : Effect.succeed(value);
  };

  const send = (request: Omit<VendorHttpRequest, "headers">) =>
    http(request).pipe(Effect.flatMap((response) => expectOk(request.operationId, response)));

  const createDeployment = Effect.fn("vercel.create_deployment")(function* (
    call: ConnectionVendorCall,
  ) {
    const bearer = yield* token(call);
    const project = asString(call.arguments["project"]);
    const target = asString(call.arguments["target"]);
    const gitRef = asString(call.arguments["gitRef"]);
    // The repository is read from the project's own link rather than taken as
    // an argument: a bot naming a repository here would be naming what gets
    // deployed to a site the owner approved by project name.
    const found = asRecord(
      yield* send({
        operationId: call.operationId,
        method: "GET",
        url: scoped(`/v9/projects/${encodeURIComponent(project)}`, call.account),
        bearer,
      }),
    );
    const link = asRecord(found["link"]);
    const repoId = link["repoId"];
    if (link["type"] !== "github" || repoId === undefined || repoId === null) {
      return yield* Effect.fail(
        vendorFailure(
          call.operationId,
          `The Vercel project ${project} is not linked to a GitHub repository, so there is nothing to deploy from. Link it first.`,
        ),
      );
    }
    const deployment = asRecord(
      yield* send({
        operationId: call.operationId,
        method: "POST",
        url: scoped("/v13/deployments", call.account),
        bearer,
        body: {
          name: project,
          project: asString(found["id"]),
          target,
          gitSource: { type: "github", repoId, ref: gitRef },
        },
      }),
    );
    const url = asString(deployment["url"]);
    return {
      deploymentId: asString(deployment["id"]),
      // Vercel reports a bare host; a bot handing the owner a link should not
      // have to guess the scheme.
      url: url.length === 0 ? "" : url.startsWith("http") ? url : `https://${url}`,
      target: asString(deployment["target"]) === "" ? target : asString(deployment["target"]),
    };
  });

  const execute = Effect.fn("vercel.execute")(function* (call: ConnectionVendorCall) {
    switch (call.operationId) {
      case "vercel.list_projects": {
        const bearer = yield* token(call);
        const body = asRecord(
          yield* send({
            operationId: call.operationId,
            method: "GET",
            url: scoped("/v9/projects?limit=100", call.account),
            bearer,
          }),
        );
        const rows = Array.isArray(body["projects"]) ? body["projects"] : [];
        return {
          projects: rows.map((row) => {
            const project = asRecord(row);
            return {
              project: asString(project["name"]),
              projectId: asString(project["id"]),
              framework: asString(project["framework"]),
            };
          }),
        };
      }
      case "vercel.create_project": {
        const bearer = yield* token(call);
        const repository = call.arguments["githubRepository"];
        const framework = call.arguments["framework"];
        const created = asRecord(
          yield* send({
            operationId: call.operationId,
            method: "POST",
            url: scoped("/v10/projects", call.account),
            bearer,
            body: {
              name: asString(call.arguments["name"]),
              ...(typeof framework === "string" ? { framework } : {}),
              ...(typeof repository === "string"
                ? { gitRepository: { type: "github", repo: repository } }
                : {}),
            },
          }),
        );
        return {
          project: asString(created["name"]),
          projectId: asString(created["id"]),
          framework: asString(created["framework"]),
        };
      }
      case "vercel.set_environment_variables": {
        const bearer = yield* token(call);
        const project = asString(call.arguments["project"]);
        const target = asString(call.arguments["target"]);
        const variables = (call.arguments["variables"] ?? []) as ReadonlyArray<{
          key: string;
          value: string;
        }>;
        const keys = yield* setVercelEnvironmentVariables({
          http,
          operationId: call.operationId,
          bearer,
          account: call.account,
          project,
          target,
          variables: variables.map((variable) => ({
            key: variable.key,
            value: Redacted.make(variable.value),
          })),
        });
        return { project, target, keys };
      }
      case "vercel.create_deployment":
        return yield* createDeployment(call);
      default:
        return yield* Effect.fail(
          vendorFailure(call.operationId, "The Vercel adapter does not implement this operation."),
        );
    }
  });

  const validate: ConnectionVendorAdapter["validate"] = (credentials) =>
    Effect.gen(function* () {
      const bearer = yield* token({ operationId: "vercel.validate", credentials });
      const ask = (url: string) =>
        http({ operationId: "vercel.validate", method: "GET", url, bearer }).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(response.body)
              : Effect.fail(
                  vendorFailure(
                    "vercel.validate",
                    `HTTP ${response.status}: ${JSON.stringify(response.body)}`,
                    isUnauthorizedStatus(response.status),
                  ),
                ),
          ),
        );
      const user = asRecord(asRecord(yield* ask(`${API}/v2/user`))["user"]);
      const teamsBody = asRecord(yield* ask(`${API}/v2/teams?limit=20`));
      const teams = (Array.isArray(teamsBody["teams"]) ? teamsBody["teams"] : []).map(asRecord);
      // More than one team means every later call would have to pick a scope,
      // and picking wrong deploys to the wrong account. The owner narrows the
      // token instead; Vercel's token page has that choice on it.
      if (teams.length > 1) {
        return yield* Effect.fail(
          vendorFailure(
            "vercel.validate",
            `This token can reach ${teams.length} Vercel scopes (${teams
              .map((team) => asString(team["name"]))
              .join(", ")}). Create a token scoped to the one account hbots should use.`,
          ),
        );
      }
      const team = teams[0];
      return {
        account: {
          accountId: asString(user["id"]),
          accountName: asString(user["username"]),
          teamId: team === undefined ? null : asString(team["id"]),
          teamName: team === undefined ? null : asString(team["name"]),
        },
        // Vercel tokens carry no scope list: what they may do is decided by the
        // scope they were minted for, which is the team resolved above.
        grantedScopes: null,
        verifiedCapabilities: [
          "vercel.list_projects",
          "vercel.create_project",
          "vercel.set_environment_variables",
          "vercel.create_deployment",
        ],
      };
    });

  return {
    vendorId: "vercel",
    vendorSchema: (operationId) => {
      const schema = VENDOR_SCHEMAS[operationId];
      return schema === undefined
        ? Effect.fail(
            vendorFailure(
              operationId,
              `The Vercel adapter does not speak for ${operationId}. Nothing ran.`,
            ),
          )
        : Effect.succeed(schema);
    },
    execute,
    validate,
  };
};
