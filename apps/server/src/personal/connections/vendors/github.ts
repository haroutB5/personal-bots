// @effect-diagnostics preferSchemaOverJson:off - quoting a vendor's own error body back, not decoding a known shape.
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type {
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
 * GitHub over its REST API.
 *
 * The shapes below are stated here as literals rather than read back from the
 * operation catalog on purpose: the gateway's drift check is only worth
 * anything if the adapter says independently what it speaks. `github.test.ts`
 * asserts the two agree, so changing a vendor contract means changing both
 * deliberately and watching that test fail first.
 */

const API = "https://api.github.com";

const VENDOR_SCHEMAS: Readonly<Record<string, string>> = {
  "github.list_repositories": "github/repos@2026-09-20",
  "github.create_repository": "github/repos@2026-09-20",
  "github.push_files": "github/git-data@2026-09-20",
};

const HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
} as const;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export const makeGithubAdapter = (http: VendorHttp): ConnectionVendorAdapter => {
  const token = (call: Pick<ConnectionVendorCall, "credentials" | "operationId">) => {
    const value = call.credentials["accessToken"];
    return value === undefined
      ? Effect.fail(
          vendorFailure(call.operationId, "The GitHub connection has no access token stored."),
        )
      : Effect.succeed(value);
  };

  const send = (request: Omit<VendorHttpRequest, "headers">) =>
    http({ ...request, headers: HEADERS }).pipe(
      Effect.flatMap((response) => expectOk(request.operationId, response)),
    );

  /**
   * The commit the new one sits on: the branch's own tip, else the default
   * branch's. A branch that exists nowhere in the repository is a first
   * commit, and only then are we allowed to write one with no parent.
   */
  const resolveBase = Effect.fn("github.resolveBase")(function* (input: {
    readonly operationId: string;
    readonly bearer: Redacted.Redacted<string>;
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
  }) {
    const readRef = (branch: string) =>
      http({
        operationId: input.operationId,
        method: "GET",
        url: `${API}/repos/${input.owner}/${input.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        bearer: input.bearer,
        headers: HEADERS,
      }).pipe(
        Effect.flatMap((response): Effect.Effect<string | null, ConnectionVendorError> =>
          response.status === 404
            ? Effect.succeed(null)
            : expectOk(input.operationId, response).pipe(
                Effect.map((body) => {
                  const sha = asString(asRecord(asRecord(body)["object"])["sha"]);
                  return sha.length === 0 ? null : sha;
                }),
              ),
        ),
      );
    const onBranch = yield* readRef(input.branch);
    if (onBranch !== null) return { parent: onBranch, branchExists: true };
    const repository = asRecord(
      yield* send({
        operationId: input.operationId,
        method: "GET",
        url: `${API}/repos/${input.owner}/${input.repo}`,
        bearer: input.bearer,
      }),
    );
    const fallback = asString(repository["default_branch"]);
    if (fallback.length > 0 && fallback !== input.branch) {
      const onDefault = yield* readRef(fallback);
      if (onDefault !== null) return { parent: onDefault, branchExists: false };
    }
    return { parent: null, branchExists: false };
  });

  const pushFiles = Effect.fn("github.push_files")(function* (call: ConnectionVendorCall) {
    const bearer = yield* token(call);
    const repository = asString(call.arguments["repository"]);
    const branch = asString(call.arguments["branch"]);
    const files = (call.arguments["files"] ?? []) as ReadonlyArray<{
      path: string;
      contents: string;
    }>;
    const parts = repository.split("/");
    // A one-part name would silently become a URL about a different resource.
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      return yield* Effect.fail(
        vendorFailure(
          call.operationId,
          `A GitHub repository must be given as owner/name; got '${repository}'.`,
        ),
      );
    }
    const [owner, repo] = [parts[0], parts[1]];
    const base = yield* resolveBase({
      operationId: call.operationId,
      bearer,
      owner,
      repo,
      branch,
    });

    const blobs: Array<{ path: string; sha: string }> = [];
    for (const file of files) {
      const blob = asRecord(
        yield* send({
          operationId: call.operationId,
          method: "POST",
          url: `${API}/repos/${owner}/${repo}/git/blobs`,
          bearer,
          body: {
            content: Buffer.from(file.contents, "utf8").toString("base64"),
            encoding: "base64",
          },
        }),
      );
      blobs.push({ path: file.path, sha: asString(blob["sha"]) });
    }

    const tree = asRecord(
      yield* send({
        operationId: call.operationId,
        method: "POST",
        url: `${API}/repos/${owner}/${repo}/git/trees`,
        bearer,
        body: {
          ...(base.parent === null ? {} : { base_tree: base.parent }),
          tree: blobs.map((blob) => ({
            path: blob.path,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          })),
        },
      }),
    );

    const commit = asRecord(
      yield* send({
        operationId: call.operationId,
        method: "POST",
        url: `${API}/repos/${owner}/${repo}/git/commits`,
        bearer,
        body: {
          // Written here, never by the bot: the commit log is owner-facing text.
          message: `Update ${files.length} file${files.length === 1 ? "" : "s"}`,
          tree: asString(tree["sha"]),
          parents: base.parent === null ? [] : [base.parent],
        },
      }),
    );
    const commitSha = asString(commit["sha"]);

    // Never force: an existing branch is fast-forwarded by GitHub's own rules,
    // and a missing one is created rather than moved.
    yield* base.branchExists
      ? send({
          operationId: call.operationId,
          method: "PATCH",
          url: `${API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
          bearer,
          body: { sha: commitSha, force: false },
        })
      : send({
          operationId: call.operationId,
          method: "POST",
          url: `${API}/repos/${owner}/${repo}/git/refs`,
          bearer,
          body: { ref: `refs/heads/${branch}`, sha: commitSha },
        });

    return { repository, branch, commitSha };
  });

  const execute = Effect.fn("github.execute")(function* (call: ConnectionVendorCall) {
    switch (call.operationId) {
      case "github.list_repositories": {
        const bearer = yield* token(call);
        const body = yield* send({
          operationId: call.operationId,
          method: "GET",
          url: `${API}/user/repos?per_page=100&sort=updated`,
          bearer,
        });
        const rows = Array.isArray(body) ? body : [];
        return {
          repositories: rows.map((row) => {
            const repo = asRecord(row);
            return {
              repository: asString(repo["full_name"]),
              visibility: repo["private"] === true ? "private" : "public",
              defaultBranch: asString(repo["default_branch"]),
              htmlUrl: asString(repo["html_url"]),
            };
          }),
        };
      }
      case "github.create_repository": {
        const bearer = yield* token(call);
        const created = asRecord(
          yield* send({
            operationId: call.operationId,
            method: "POST",
            url: `${API}/user/repos`,
            bearer,
            body: {
              name: asString(call.arguments["name"]),
              private: call.arguments["visibility"] !== "public",
              // The push operation writes the first commit; an auto README
              // would make that commit a merge nobody asked for.
              auto_init: false,
            },
          }),
        );
        return {
          repository: asString(created["full_name"]),
          htmlUrl: asString(created["html_url"]),
        };
      }
      case "github.push_files":
        return yield* pushFiles(call);
      default:
        return yield* Effect.fail(
          vendorFailure(call.operationId, `The GitHub adapter does not implement this operation.`),
        );
    }
  });

  const validate: ConnectionVendorAdapter["validate"] = (credentials) =>
    Effect.gen(function* () {
      const bearer = yield* token({ operationId: "github.validate", credentials });
      const response = yield* http({
        operationId: "github.validate",
        method: "GET",
        url: `${API}/user`,
        bearer,
        headers: HEADERS,
      });
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          vendorFailure(
            "github.validate",
            typeof response.body === "object" && response.body !== null
              ? `HTTP ${response.status}: ${JSON.stringify(response.body)}`
              : `HTTP ${response.status}`,
            isUnauthorizedStatus(response.status),
          ),
        );
      }
      const user = asRecord(response.body);
      const header = response.headers["x-oauth-scopes"];
      // A fine-grained token reports no scope header at all. That is "we
      // cannot tell", and the service must not read it as "has none".
      const grantedScopes =
        header === undefined
          ? null
          : header
              .split(",")
              .map((scope) => scope.trim())
              .filter((scope) => scope.length > 0);
      const writes = grantedScopes !== null && grantedScopes.includes("repo");
      return {
        account: {
          accountId: String(user["id"] ?? ""),
          accountName: asString(user["login"]),
          teamId: null,
          teamName: null,
        },
        grantedScopes,
        verifiedCapabilities: writes
          ? ["github.list_repositories", "github.create_repository", "github.push_files"]
          : ["github.list_repositories"],
      };
    });

  return {
    vendorId: "github",
    vendorSchema: (operationId) => {
      const schema = VENDOR_SCHEMAS[operationId];
      return schema === undefined
        ? Effect.fail(
            vendorFailure(
              operationId,
              `The GitHub adapter does not speak for ${operationId}. Nothing ran.`,
            ),
          )
        : Effect.succeed(schema);
    },
    execute,
    validate,
  };
};
