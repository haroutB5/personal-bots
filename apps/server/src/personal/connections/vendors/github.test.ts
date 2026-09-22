import { ConnectionId } from "@t3tools/contracts";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { operationsForVendor } from "../operations.ts";
import { makeGithubAdapter } from "./github.ts";
import type { VendorHttp, VendorHttpRequest, VendorHttpResponse } from "./vendorHttp.ts";

/** Distinctive enough that finding it anywhere outside a header is a leak. */
const TOKEN = "ghp_fake_TOKEN_value_0123456789";
const credentials = { accessToken: Redacted.make(TOKEN) };

/** One connection stands for the account under test. */
const CONNECTION = ConnectionId.make("connection-under-test");

const text = (value: unknown) =>
  NodeUtil.inspect(value, { depth: null, breakLength: Infinity, maxStringLength: null });

interface Route {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const harness = (routes: Readonly<Record<string, Route | ReadonlyArray<Route>>>) => {
  const requests: Array<VendorHttpRequest> = [];
  const pending = new Map<string, Array<Route>>(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );
  const http: VendorHttp = (request) =>
    Effect.sync((): VendorHttpResponse => {
      requests.push(request);
      const key = `${request.method} ${request.url}`;
      const queue = pending.get(key);
      const route = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
      if (route === undefined) {
        return { status: 599, body: { message: `no route for ${key}` }, headers: {} };
      }
      return {
        status: route.status ?? 200,
        body: route.body ?? null,
        headers: route.headers ?? {},
      };
    });
  return { requests, adapter: makeGithubAdapter(http) };
};

const USER_OK: Route = {
  body: { id: 42, login: "haroutB5" },
  headers: { "x-oauth-scopes": "repo, workflow, gist" },
};

describe("github adapter", () => {
  it.effect("speaks exactly the vendor shape every github operation was reviewed against", () =>
    Effect.gen(function* () {
      const { adapter } = harness({});
      for (const operation of operationsForVendor("github")) {
        const spoken = yield* adapter.vendorSchema(operation.operationId);
        expect(spoken, operation.operationId).toBe(operation.reviewedVendorSchema);
      }
      expect(operationsForVendor("github").length).toBeGreaterThan(0);
    }),
  );

  it.effect("fails rather than guessing a shape for an operation it does not implement", () =>
    Effect.gen(function* () {
      const { adapter } = harness({});
      const error = yield* Effect.flip(adapter.vendorSchema("github.delete_everything"));
      expect(error.detail).toContain("github.delete_everything");
    }),
  );

  it.effect("resolves the account and the scopes GitHub reports for the token", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({ "GET https://api.github.com/user": USER_OK });
      const validation = yield* adapter.validate(credentials);
      expect(validation.account).toEqual({
        accountId: "42",
        accountName: "haroutB5",
        teamId: null,
        teamName: null,
      });
      expect(validation.grantedScopes).toEqual(["repo", "workflow", "gist"]);
      expect(validation.verifiedCapabilities).toContain("github.create_repository");
      expect(validation.verifiedCapabilities).toContain("github.push_files");
      // The token is a header value and nothing else: not a query string, not a body.
      expect(text(requests.map((request) => [request.url, request.body]))).not.toContain(TOKEN);
    }),
  );

  it.effect("reports unknown scopes rather than none when GitHub sends no scope header", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.github.com/user": { body: { id: 7, login: "fine-grained" } },
      });
      const validation = yield* adapter.validate(credentials);
      expect(validation.grantedScopes).toBeNull();
      // Nothing was proven beyond the identity call that just succeeded.
      expect(validation.verifiedCapabilities).toEqual(["github.list_repositories"]);
    }),
  );

  it.effect("marks a rejected token as unauthorized so the connection can move state", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.github.com/user": { status: 401, body: { message: "Bad credentials" } },
      });
      const error = yield* Effect.flip(adapter.validate(credentials));
      expect(error.unauthorized).toBe(true);
      expect(error.detail).toContain("Bad credentials");
    }),
  );

  it.effect("does not call a failed request unauthorized just because it failed", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.github.com/user": { status: 500, body: { message: "server error" } },
      });
      const error = yield* Effect.flip(adapter.validate(credentials));
      expect(error.unauthorized).toBeUndefined();
    }),
  );

  it.effect("creates a repository with the visibility it was given", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "POST https://api.github.com/user/repos": {
          status: 201,
          body: {
            full_name: "haroutB5/scratch",
            html_url: "https://github.com/haroutB5/scratch",
            private: true,
            id: 999,
          },
        },
      });
      const result = yield* adapter.execute({
        operationId: "github.create_repository",
        arguments: { name: "scratch", visibility: "private" },
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: null,
      });
      expect(requests[0]?.body).toEqual({ name: "scratch", private: true, auto_init: false });
      expect(result).toEqual({
        repository: "haroutB5/scratch",
        htmlUrl: "https://github.com/haroutB5/scratch",
      });
    }),
  );

  it.effect("lists repositories as name, visibility and default branch only", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.github.com/user/repos?per_page=100&sort=updated": {
          body: [
            {
              full_name: "haroutB5/one",
              private: false,
              default_branch: "main",
              html_url: "https://github.com/haroutB5/one",
              // A field nobody reviewed, which must not survive the mapping.
              owner: { email: "harout@example.com" },
            },
          ],
        },
      });
      const result = yield* adapter.execute({
        operationId: "github.list_repositories",
        arguments: {},
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: null,
      });
      expect(result).toEqual({
        repositories: [
          {
            repository: "haroutB5/one",
            visibility: "public",
            defaultBranch: "main",
            htmlUrl: "https://github.com/haroutB5/one",
          },
        ],
      });
      expect(text(result)).not.toContain("harout@example.com");
    }),
  );

  const pushRoutes = (refExists: boolean) => ({
    "GET https://api.github.com/repos/haroutB5/app/git/ref/heads/main": refExists
      ? { body: { object: { sha: "base-commit" } } }
      : { status: 404, body: { message: "Not Found" } },
    "GET https://api.github.com/repos/haroutB5/app": { body: { default_branch: "main" } },
    "POST https://api.github.com/repos/haroutB5/app/git/blobs": [
      { status: 201, body: { sha: "blob-1" } },
      { status: 201, body: { sha: "blob-2" } },
    ],
    "POST https://api.github.com/repos/haroutB5/app/git/trees": {
      status: 201,
      body: { sha: "tree-1" },
    },
    "POST https://api.github.com/repos/haroutB5/app/git/commits": {
      status: 201,
      body: { sha: "commit-1" },
    },
    "PATCH https://api.github.com/repos/haroutB5/app/git/refs/heads/main": {
      body: { object: { sha: "commit-1" } },
    },
    "POST https://api.github.com/repos/haroutB5/app/git/refs": {
      status: 201,
      body: { object: { sha: "commit-1" } },
    },
  });

  const pushCall = {
    operationId: "github.push_files",
    arguments: {
      repository: "haroutB5/app",
      branch: "main",
      files: [
        { path: "index.html", contents: "<h1>hi</h1>" },
        { path: "README.md", contents: "" },
      ],
    },
    credentials,
    connectionId: CONNECTION,
    settings: { whatsappDailySendCap: null },
    account: null,
  };

  it.effect("pushes every file as one commit on top of the branch it was given", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness(pushRoutes(true));
      const result = yield* adapter.execute(pushCall);
      expect(result).toEqual({
        repository: "haroutB5/app",
        branch: "main",
        commitSha: "commit-1",
      });
      const tree = requests.find((request) => request.url.endsWith("/git/trees"))?.body as {
        base_tree?: string;
        tree: ReadonlyArray<{ path: string; sha: string }>;
      };
      expect(tree.base_tree).toBe("base-commit");
      expect(tree.tree.map((entry) => entry.path)).toEqual(["index.html", "README.md"]);
      const commit = requests.find((request) => request.url.endsWith("/git/commits"))?.body as {
        parents: ReadonlyArray<string>;
      };
      expect(commit.parents).toEqual(["base-commit"]);
      // One commit, not one per file: an empty file still gets a blob.
      expect(requests.filter((request) => request.url.endsWith("/git/commits"))).toHaveLength(1);
      expect(requests.filter((request) => request.url.endsWith("/git/blobs"))).toHaveLength(2);
    }),
  );

  /** What GitHub answers for any Git Data read or write on a repository with no commit. */
  const EMPTY_REPOSITORY: Route = { status: 409, body: { message: "Git Repository is empty." } };
  const SEED: Route = { status: 201, body: { commit: { sha: "seed-commit" } } };

  it.effect("seeds an empty repository through the Contents API, then pushes on top of it", () =>
    Effect.gen(function* () {
      // The create_app case: a repository made with auto_init false, pushed
      // to its default branch. The ref read answers 409 until the seed lands.
      const { adapter, requests } = harness({
        ...pushRoutes(true),
        "GET https://api.github.com/repos/haroutB5/app/git/ref/heads/main": [
          EMPTY_REPOSITORY,
          { body: { object: { sha: "seed-commit" } } },
        ],
        "PUT https://api.github.com/repos/haroutB5/app/contents/index.html": SEED,
      });
      const result = yield* adapter.execute(pushCall);
      expect(result).toEqual({ repository: "haroutB5/app", branch: "main", commitSha: "commit-1" });

      const seedIndex = requests.findIndex((request) => request.method === "PUT");
      const firstBlob = requests.findIndex((request) => request.url.endsWith("/git/blobs"));
      // Nothing touches Git Data before the repository has a commit.
      expect(seedIndex).toBeGreaterThanOrEqual(0);
      expect(seedIndex).toBeLessThan(firstBlob);
      expect(requests[seedIndex]?.body).toMatchObject({
        content: Buffer.from("<h1>hi</h1>", "utf8").toString("base64"),
      });
      const commit = requests.find((request) => request.url.endsWith("/git/commits"))?.body as {
        parents: ReadonlyArray<string>;
      };
      expect(commit.parents).toEqual(["seed-commit"]);
      const tree = requests.find((request) => request.url.endsWith("/git/trees"))?.body as {
        base_tree?: string;
        tree: ReadonlyArray<{ path: string }>;
      };
      expect(tree.base_tree).toBe("seed-commit");
      expect(tree.tree.map((entry) => entry.path)).toEqual(["index.html", "README.md"]);
      // The seeded branch is fast-forwarded, never forced.
      const patch = requests.find((request) => request.method === "PATCH");
      expect(patch?.body).toEqual({ sha: "commit-1", force: false });
    }),
  );

  it.effect("creates a non-default branch off the seed of an empty repository", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        ...pushRoutes(true),
        "GET https://api.github.com/repos/haroutB5/app": { body: { default_branch: "trunk" } },
        "GET https://api.github.com/repos/haroutB5/app/git/ref/heads/main": [
          EMPTY_REPOSITORY,
          { status: 404, body: { message: "Not Found" } },
        ],
        "GET https://api.github.com/repos/haroutB5/app/git/ref/heads/trunk": [
          EMPTY_REPOSITORY,
          { body: { object: { sha: "seed-commit" } } },
        ],
        "PUT https://api.github.com/repos/haroutB5/app/contents/index.html": SEED,
      });
      const result = yield* adapter.execute(pushCall);
      expect(result).toMatchObject({ branch: "main", commitSha: "commit-1" });
      const commit = requests.find((request) => request.url.endsWith("/git/commits"))?.body as {
        parents: ReadonlyArray<string>;
      };
      expect(commit.parents).toEqual(["seed-commit"]);
      // A branch that does not exist is created, never force-moved.
      expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      expect(
        requests.some((request) => request.method === "POST" && request.url.endsWith("/git/refs")),
      ).toBe(true);
    }),
  );

  it.effect("branches a new branch off the default branch rather than orphaning it", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        ...pushRoutes(true),
        "GET https://api.github.com/repos/haroutB5/app/git/ref/heads/feature": {
          status: 404,
          body: { message: "Not Found" },
        },
      });
      const result = yield* adapter.execute({
        ...pushCall,
        arguments: { ...pushCall.arguments, branch: "feature" },
      });
      expect(result).toMatchObject({ branch: "feature", commitSha: "commit-1" });
      const commit = requests.find((request) => request.url.endsWith("/git/commits"))?.body as {
        parents: ReadonlyArray<string>;
      };
      expect(commit.parents).toEqual(["base-commit"]);
    }),
  );

  it.effect("does not call a missing permission a dead token", () =>
    Effect.gen(function* () {
      // A fine-grained token without Contents: write. The token is fine;
      // disabling the connection would stop every read as well.
      const { adapter } = harness({
        ...pushRoutes(true),
        "POST https://api.github.com/repos/haroutB5/app/git/blobs": {
          status: 403,
          body: { message: "Resource not accessible by personal access token" },
        },
      });
      const error = yield* Effect.flip(adapter.execute(pushCall));
      expect(error.unauthorized).toBeUndefined();
      expect(error.status).toBe(403);
      expect(error.detail).toContain("Resource not accessible");
    }),
  );

  it.effect("still calls a 401 on an operation a dead token", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        ...pushRoutes(true),
        "POST https://api.github.com/repos/haroutB5/app/git/blobs": {
          status: 401,
          body: { message: "Bad credentials" },
        },
      });
      const error = yield* Effect.flip(adapter.execute(pushCall));
      expect(error.unauthorized).toBe(true);
    }),
  );

  it.effect("refuses a repository that is not owner/name rather than building a wrong URL", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness(pushRoutes(true));
      const error = yield* Effect.flip(
        adapter.execute({ ...pushCall, arguments: { ...pushCall.arguments, repository: "app" } }),
      );
      expect(error.detail).toContain("owner/name");
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("keeps the token out of every failure it reports", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "POST https://api.github.com/user/repos": {
          status: 422,
          body: { message: "name already exists on this account" },
        },
      });
      const error = yield* Effect.flip(
        adapter.execute({
          operationId: "github.create_repository",
          arguments: { name: "scratch", visibility: "public" },
          credentials,
          connectionId: CONNECTION,
          settings: { whatsappDailySendCap: null },
          account: null,
        }),
      );
      expect(error.detail).toContain("already exists");
      expect(text(error)).not.toContain(TOKEN);
    }),
  );
});
