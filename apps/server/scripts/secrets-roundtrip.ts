#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a standalone proof script: it runs the real CLI and reads the store with plain fs.
/**
 * Round-trips fake secrets through the real `secrets export` and `import` CLI.
 * Run from apps/server: `node scripts/secrets-roundtrip.ts`. Exit 1 on failure.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  createWrappedDataKey,
  openSecret,
  parseWrappedDataKey,
  resolveMachineMaterial,
  sealSecret,
  serializeWrappedDataKey,
  tryUnwrapDataKey,
} from "../src/auth/secretEncryption.ts";

const PASS = "roundtrip test passphrase 12345";
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const serverDir = NodePath.dirname(here);
const bin = NodePath.join(serverDir, "src", "bin.ts");
// --keep leaves the bundle (and its store) on disk and prints its path, so the
// same bundle can be imported on the other machine as a cross-machine proof.
const keepBundle = process.argv.includes("--keep");

const fail = (message: string): never => {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(1);
};

const temp = (name: string) => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `hbots-${name}-`));

const values = {
  "personal-login-eeee": "fake-login-password",
  "personal-secret-ffff": "sk-fake-roundtrip-key",
  "personal-connection-9999": "fake-connection-token",
};

const source = temp("secrets-src");
const { dataKey, file } = createWrappedDataKey();
NodeFS.writeFileSync(
  NodePath.join(source, "data-encryption-key.json"),
  serializeWrappedDataKey(file),
);
for (const [name, value] of Object.entries(values)) {
  NodeFS.writeFileSync(
    NodePath.join(source, `${name}.bin`),
    Buffer.from(sealSecret(dataKey, name, new TextEncoder().encode(value))),
  );
}
dataKey.fill(0);
process.stdout.write(`PASS source store sealed with ${resolveMachineMaterial()?.source ?? "?"}\n`);

const run = (args: ReadonlyArray<string>): void => {
  const result = NodeChildProcess.spawnSync(process.execPath, [bin, "secrets", ...args], {
    cwd: serverDir,
    env: { ...process.env, HBOTS_SECRETS_PASSPHRASE: PASS },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(
      `\`t3 secrets ${args[0]}\` exited ${String(result.status)}: ${(result.stderr ?? "").trim()}`,
    );
  }
  // The CLI must never echo the passphrase or a secret value.
  for (const value of [...Object.values(values), PASS]) {
    if (`${result.stdout}${result.stderr}`.includes(value)) fail(`${args[0]} printed a secret`);
  }
};

const bundle = NodePath.join(temp("secrets-bundle"), "secrets.json");
run(["export", "--secrets-dir", source, "--out", bundle, "--json"]);
process.stdout.write("PASS export through the CLI\n");

const rawBundle = NodeFS.readFileSync(bundle, "utf8");
for (const value of Object.values(values)) {
  if (rawBundle.includes(value)) fail("the bundle contains a plaintext secret");
}
if (rawBundle.includes(PASS)) fail("the bundle contains the passphrase");
process.stdout.write("PASS bundle has no plaintext secret and no passphrase\n");

const target = temp("secrets-dst");
run(["import", "--secrets-dir", target, "--in", bundle, "--json"]);
process.stdout.write("PASS import through the CLI\n");

// Read it back the way ServerSecretStore does, with this machine's material.
const material = resolveMachineMaterial();
if (material === null) throw new Error("no machine material on this computer");
const keyFile = parseWrappedDataKey(
  NodeFS.readFileSync(NodePath.join(target, "data-encryption-key.json"), "utf8"),
);
const outcome = tryUnwrapDataKey(keyFile, material);
if (outcome._tag !== "Opened")
  throw new Error(`the imported key file does not open here: ${outcome.reason}`);
const opened = outcome.dataKey;
try {
  for (const [name, value] of Object.entries(values)) {
    const plaintext = openSecret(
      opened,
      name,
      Uint8Array.from(NodeFS.readFileSync(NodePath.join(target, `${name}.bin`))),
    );
    const text = new TextDecoder().decode(plaintext);
    plaintext.fill(0);
    if (text !== value) fail(`"${name}" did not survive the round trip`);
  }
} finally {
  opened.fill(0);
}
process.stdout.write("PASS every saved secret opens with this machine's re-sealed key\n");

// A second import is a no-op (idempotent).
const again = NodeChildProcess.spawnSync(
  process.execPath,
  [bin, "secrets", "import", "--secrets-dir", target, "--in", bundle, "--json"],
  {
    cwd: serverDir,
    env: { ...process.env, HBOTS_SECRETS_PASSPHRASE: PASS },
    encoding: "utf8",
  },
);
if (again.status !== 0) fail(`second import exited ${String(again.status)}`);
const summary = JSON.parse((again.stdout ?? "").trim().split("\n").pop() ?? "{}");
if (summary.imported !== 0 || summary.unchanged !== Object.keys(values).length) {
  fail(`second import was not a no-op: ${JSON.stringify(summary)}`);
}
process.stdout.write("PASS second import changes nothing\n");

// A wrong passphrase fails with a non-zero exit and no partial store.
const wrongTarget = temp("secrets-wrong");
const wrong = NodeChildProcess.spawnSync(
  process.execPath,
  [bin, "secrets", "import", "--secrets-dir", wrongTarget, "--in", bundle],
  {
    cwd: serverDir,
    env: { ...process.env, HBOTS_SECRETS_PASSPHRASE: "wrong passphrase 0000" },
    encoding: "utf8",
  },
);
if (wrong.status === 0) fail("a wrong passphrase was accepted");
if (NodeFS.readdirSync(wrongTarget).length !== 0) fail("a failed import left files behind");
process.stdout.write("PASS wrong passphrase refused, target untouched\n");

for (const dir of [source, target, wrongTarget, NodePath.dirname(bundle)]) {
  if (keepBundle && dir === NodePath.dirname(bundle)) continue;
  NodeFS.rmSync(dir, { recursive: true, force: true });
}
if (keepBundle) {
  process.stdout.write(`KEEP_BUNDLE=${bundle}\n`);
  process.stdout.write(`KEEP_STORE=${target}\n`);
}
process.stdout.write("PASS secrets round trip complete\n");
