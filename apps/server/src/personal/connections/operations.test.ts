import { ConnectionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Operations from "./operations.ts";

const prepare = (operationId: string, args: unknown) =>
  Operations.findOperation(operationId).pipe(
    Option.map((operation) => operation.prepare(args)),
    Option.getOrThrow,
  );

describe("connection operations", () => {
  it("has no operation under an unknown name", () => {
    expect(Option.isNone(Operations.findOperation("github.delete_everything"))).toBe(true);
    expect(Option.isNone(Operations.findOperation("github.list_repositories "))).toBe(false);
  });

  it.effect("validates arguments against the operation's own schema", () =>
    Effect.gen(function* () {
      const good = yield* prepare("github.create_repository", {
        name: "hbots-demo",
        visibility: "private",
      });
      expect(good.arguments).toEqual({ name: "hbots-demo", visibility: "private" });

      // An argument the schema does not describe is a different action from
      // the one we reviewed, so it stops rather than being ignored.
      const extra = yield* Effect.flip(
        prepare("github.create_repository", {
          name: "hbots-demo",
          visibility: "private",
          org: "someone-else",
        }),
      );
      expect(extra._tag).toBe("ConnectionOperationArgumentError");

      const missing = yield* Effect.flip(prepare("github.create_repository", { name: "x" }));
      expect(missing._tag).toBe("ConnectionOperationArgumentError");

      const wrongValue = yield* Effect.flip(
        prepare("github.create_repository", { name: "x", visibility: "secret" }),
      );
      expect(wrongValue._tag).toBe("ConnectionOperationArgumentError");
    }),
  );

  it.effect("classifies risk from the operation and its validated arguments", () =>
    Effect.gen(function* () {
      const read = yield* prepare("github.list_repositories", {});
      expect(read.risk.approvalRequired).toBe(false);
      expect(read.risk.reason).toBe("read_only");

      const create = yield* prepare("github.create_repository", {
        name: "hbots-demo",
        visibility: "private",
      });
      expect(create.risk).toMatchObject({ approvalRequired: true, reason: "account_write" });

      // Arguments, not the tool name, decide: the same operation reads as a
      // publication when the repository would be public.
      const publish = yield* prepare("github.create_repository", {
        name: "hbots-demo",
        visibility: "public",
      });
      expect(publish.risk.reason).toBe("publication");
      expect(publish.risk.summary).toContain("public");

      // A repository write can ship: it is a deployment whatever the branch.
      const push = yield* prepare("github.push_files", {
        repository: "me/app",
        branch: "spike",
        files: [{ path: "index.ts", contents: "export {}" }],
      });
      expect(push.risk).toMatchObject({ approvalRequired: true, reason: "deployment" });
    }),
  );

  it.effect("gates generic SQL and Redis as a class, without reading the statement", () =>
    Effect.gen(function* () {
      const select = yield* prepare("neon.run_sql", {
        project: "proj_1",
        database: "app",
        statement: "SELECT 1",
      });
      expect(select.risk).toMatchObject({
        approvalRequired: true,
        reason: "unbounded_statement",
      });
      // The statement is carried for the owner to read, never parsed to
      // decide: "SELECT 1" and "DROP TABLE users" classify identically.
      const drop = yield* prepare("neon.run_sql", {
        project: "proj_1",
        database: "app",
        statement: "DROP TABLE users",
      });
      expect({ approvalRequired: drop.risk.approvalRequired, reason: drop.risk.reason }).toEqual({
        approvalRequired: select.risk.approvalRequired,
        reason: select.risk.reason,
      });
      // The owner reads the statement verbatim; the classifier still never did.
      expect(drop.risk.summary).toContain("users");

      const redis = yield* prepare("upstash.redis_command", {
        database: "db_1",
        command: ["GET", "key"],
      });
      expect(redis.risk).toMatchObject({
        approvalRequired: true,
        reason: "unbounded_statement",
      });
    }),
  );

  it.effect("names the resources an approval is bound to", () =>
    Effect.gen(function* () {
      const push = yield* prepare("github.push_files", {
        repository: "me/app",
        branch: "main",
        files: [{ path: "a.ts", contents: "" }],
      });
      expect(push.targetResources).toEqual(["github:repository:me/app", "github:branch:main"]);

      const deploy = yield* prepare("vercel.create_deployment", {
        project: "hbots-demo",
        target: "production",
        gitRef: "main",
      });
      expect(deploy.targetResources).toEqual([
        "vercel:project:hbots-demo",
        "vercel:target:production",
      ]);
    }),
  );
});

describe("normalizedActionDigest", () => {
  const base = {
    operationId: "github.create_repository" as const,
    arguments: { name: "hbots-demo", visibility: "private" },
    connectionId: ConnectionId.make("connection-1"),
    credentialVersion: 1,
    targetResources: ["github:repository:hbots-demo"],
  };

  it("is stable across key order and whitespace in the request", () => {
    expect(
      Operations.normalizedActionDigest({
        ...base,
        arguments: { visibility: "private", name: "hbots-demo" },
      }),
    ).toBe(Operations.normalizedActionDigest(base));
  });

  it("changes when any bound part of the action changes", () => {
    const digest = Operations.normalizedActionDigest(base);
    expect(
      Operations.normalizedActionDigest({ ...base, arguments: { ...base.arguments, name: "b" } }),
    ).not.toBe(digest);
    expect(Operations.normalizedActionDigest({ ...base, credentialVersion: 2 })).not.toBe(digest);
    expect(
      Operations.normalizedActionDigest({
        ...base,
        connectionId: ConnectionId.make("connection-2"),
      }),
    ).not.toBe(digest);
    expect(
      Operations.normalizedActionDigest({ ...base, targetResources: ["github:repository:other"] }),
    ).not.toBe(digest);
  });
});

describe("result allowlist", () => {
  it("returns only the fields the operation was reviewed to return", () => {
    const operation = Option.getOrThrow(Operations.findOperation("github.create_repository"));
    expect(
      Operations.allowlistResult(operation, {
        repository: "me/app",
        htmlUrl: "https://github.com/me/app",
        // A vendor payload the model must never see, whatever it is called.
        token: "ghp_leak",
        owner: { email: "someone@example.com" },
      }),
    ).toEqual({ repository: "me/app", htmlUrl: "https://github.com/me/app" });
  });
});

describe("scrubCredentialValues", () => {
  const token = "ghp_fake_TOKEN_value_0123456789";

  it("removes raw, url-encoded, base64 and json-escaped copies at any depth", () => {
    const text = Operations.scrubCredentialValues(
      {
        message: `401 from https://api.github.com/x?access_token=${encodeURIComponent(token)}`,
        cause: {
          body: JSON.stringify({ authorization: `Bearer ${token}` }),
          encoded: Buffer.from(token, "utf8").toString("base64"),
        },
      },
      [token],
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain(encodeURIComponent(token));
    expect(text).not.toContain(Buffer.from(token, "utf8").toString("base64"));
    expect(text).toContain("[redacted]");
    // The shape of the failure still reaches the log.
    expect(text).toContain("401");
  });

  it("leaves text alone when it carries no credential", () => {
    expect(Operations.scrubCredentialValues({ message: "404 not found" }, [token])).toContain(
      "404 not found",
    );
  });
});

describe("vercel provisioning operations", () => {
  it.effect("names preview and production as separate explicit targets", () =>
    Effect.gen(function* () {
      const preview = yield* prepare("vercel.create_deployment", {
        project: "hbots-demo",
        target: "preview",
        gitRef: "main",
      });
      expect(preview.risk.summary).toContain("preview");
      expect(preview.targetResources).toContain("vercel:target:preview");

      const production = yield* prepare("vercel.create_deployment", {
        project: "hbots-demo",
        target: "production",
        gitRef: "main",
      });
      expect(production.targetResources).toContain("vercel:target:production");

      // No default and no inference: a missing target is a refused call, not a
      // preview, because guessing the safe one still guesses.
      const guessed = yield* Effect.flip(
        prepare("vercel.create_deployment", { project: "hbots-demo", gitRef: "main" }),
      );
      expect(guessed._tag).toBe("ConnectionOperationArgumentError");
    }),
  );

  it.effect("treats creating a project as an account write, linked repository included", () =>
    Effect.gen(function* () {
      const created = yield* prepare("vercel.create_project", {
        name: "hbots-demo",
        framework: "nextjs",
        githubRepository: "haroutB5/hbots-demo",
      });
      expect(created.risk).toMatchObject({ approvalRequired: true, reason: "account_write" });
      expect(created.targetResources).toEqual([
        "vercel:project:hbots-demo",
        "github:repository:haroutB5/hbots-demo",
      ]);

      const bare = yield* prepare("vercel.create_project", {
        name: "hbots-demo",
        framework: null,
        githubRepository: null,
      });
      expect(bare.targetResources).toEqual(["vercel:project:hbots-demo"]);
    }),
  );

  it.effect("puts environment variable names in the summary and never their values", () =>
    Effect.gen(function* () {
      const secret = "postgres://user:hunter2@db.example.com/app";
      const production = yield* prepare("vercel.set_environment_variables", {
        project: "hbots-demo",
        target: "production",
        variables: [{ key: "DATABASE_URL", value: secret }],
      });
      // Production configuration is what the live site runs with, so it reads
      // as a deployment rather than a quiet account edit.
      expect(production.risk.reason).toBe("deployment");
      expect(production.risk.summary).toContain("DATABASE_URL");
      expect(production.risk.summary).not.toContain("hunter2");
      expect(production.targetResources).toContain("vercel:env:production:DATABASE_URL");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(production.targetResources)).not.toContain("hunter2");

      const preview = yield* prepare("vercel.set_environment_variables", {
        project: "hbots-demo",
        target: "preview",
        variables: [{ key: "DATABASE_URL", value: secret }],
      });
      expect(preview.risk.reason).toBe("account_write");

      // A shell-shaped name is not an environment variable name.
      const bad = yield* Effect.flip(
        prepare("vercel.set_environment_variables", {
          project: "hbots-demo",
          target: "production",
          variables: [{ key: "rm -rf /", value: "x" }],
        }),
      );
      expect(bad._tag).toBe("ConnectionOperationArgumentError");
    }),
  );

  it.effect("returns only the variable names it set, never the values", () =>
    Effect.gen(function* () {
      const operation = Option.getOrThrow(
        Operations.findOperation("vercel.set_environment_variables"),
      );
      expect(operation.resultFields).not.toContain("value");
      expect(
        Operations.allowlistResult(operation, {
          project: "hbots-demo",
          target: "production",
          keys: ["DATABASE_URL"],
          value: "hunter2",
        }),
      ).toEqual({ project: "hbots-demo", target: "production", keys: ["DATABASE_URL"] });
    }),
  );
});
