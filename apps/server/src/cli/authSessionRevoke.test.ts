// @effect-diagnostics nodeBuiltinImport:off - the CLI integration reads the state database it wrote.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    effect,
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
  );

const withStateDb = <A>(baseDir: string, use: (db: NodeSqlite.DatabaseSync) => A): A => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "statev2.sqlite"));
  try {
    return use(db);
  } finally {
    db.close();
  }
};

it.effect(
  "auth session revoke removes the phone tokens of the revoked session, as HTTP revoke does",
  () =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-revoke-test-"));
        yield* runCli(["auth", "session", "issue", "--json", "--base-dir", baseDir]);
        yield* runCli(["auth", "session", "issue", "--json", "--base-dir", baseDir]);
        const issued = (yield* TestConsole.logLines)
          .filter((line): line is string => typeof line === "string")
          .map((line) => JSON.parse(line) as { readonly sessionId: string });
        const [revoked, kept] = issued;

        withStateDb(baseDir, (db) => {
          const insert = db.prepare(
            `INSERT INTO personal_fcm_tokens
             (token, auth_session_id, subject, app_version, created_at, last_seen_at, last_error)
           VALUES (?, ?, 'owner', '1.67.5', '2026-09-18T09:00:00.000Z', '2026-09-18T09:00:00.000Z', NULL)`,
          );
          insert.run("tok-revoked", revoked!.sessionId);
          insert.run("tok-kept", kept!.sessionId);
        });

        yield* runCli(["auth", "session", "revoke", revoked!.sessionId, "--base-dir", baseDir]);

        const tokens = withStateDb(baseDir, (db) =>
          db.prepare("SELECT token FROM personal_fcm_tokens ORDER BY token").all(),
        );
        expect(tokens.map((row) => row.token)).toEqual(["tok-kept"]);
      }),
    ),
);
