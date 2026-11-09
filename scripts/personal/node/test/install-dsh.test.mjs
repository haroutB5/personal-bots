import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const HERE = import.meta.dirname;
const INSTALLER = NodePath.resolve(HERE, "..", "install-dsh.mjs");
const SOURCE_DIR = NodePath.resolve(HERE, "..", "..", "dsh-runtime");
const PIN = "0.2.1-rc.3";

function makeHome(t) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-install-dsh-"));
  t.after(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  return home;
}

function makeFakeNpm(home, { exitCode = 0 } = {}) {
  const file = NodePath.join(home, "fake-npm.sh");
  const log = NodePath.join(home, "npm-log.txt");
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh
{
  pwd
  for arg in "$@"; do printf '%s\\n' "$arg"; done
} > "${log}"
mkdir -p node_modules/@deepseek-ai/dsh/lib
printf 'console.log(process.env.FAKE_DSH_VERSION);\\n' > node_modules/@deepseek-ai/dsh/lib/bin.js
exit ${exitCode}
`,
  );
  NodeFS.chmodSync(file, 0o755);
  return { file, log };
}

function runInstaller(home, { npm, version = PIN }) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [INSTALLER, "--version", version, "--home", home, "--npm", npm],
    {
      encoding: "utf8",
      env: { ...process.env, FAKE_DSH_VERSION: version },
    },
  );
}

NodeTest.test("installs the pin into a temp home with npm ci from the committed files", (t) => {
  const home = makeHome(t);
  const { file: npm, log } = makeFakeNpm(home);

  const result = runInstaller(home, { npm });

  NodeAssert.equal(result.status, 0, result.stderr);
  const runtimeDir = NodePath.join(home, "runtimes", `dsh-${PIN}`);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(runtimeDir, "package.json")), true);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(runtimeDir, "package-lock.json")), true);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(runtimeDir, "hbots-deny-plugin.mjs")), true);
  for (const name of ["package.json", "package-lock.json", "hbots-deny-plugin.mjs"]) {
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(runtimeDir, name), "utf8"),
      NodeFS.readFileSync(NodePath.join(SOURCE_DIR, name), "utf8"),
      `${name} is copied from the committed runtime source`,
    );
  }

  const logLines = NodeFS.readFileSync(log, "utf8").trim().split("\n");
  NodeAssert.deepEqual(logLines, [runtimeDir, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  NodeAssert.match(result.stdout, new RegExp(`runtime: ${runtimeDir.replaceAll("\\", "\\\\")}`));
  NodeAssert.match(
    result.stdout,
    new RegExp(`dsh ${PIN} ready at ${runtimeDir.replaceAll("\\", "\\\\")}`),
  );
});

NodeTest.test("refuses a runtime that answers another version", (t) => {
  const home = makeHome(t);
  const { file: npm } = makeFakeNpm(home);

  const result = runInstaller(home, { npm, version: PIN });
  NodeAssert.equal(result.status, 0, result.stderr);

  // The second run reinstalls, and this time npm puts rc.4 on disk.
  const mismatchedNpm = makeFakeNpm(home);
  const mismatch = NodeChildProcess.spawnSync(
    process.execPath,
    [INSTALLER, "--version", PIN, "--home", home, "--npm", mismatchedNpm.file, "--force"],
    { encoding: "utf8", env: { ...process.env, FAKE_DSH_VERSION: "0.2.1-rc.4" } },
  );

  NodeAssert.equal(mismatch.status, 1);
  NodeAssert.match(
    mismatch.stderr,
    /Installed dsh answers '0\.2\.1-rc\.4', expected '0\.2\.1-rc\.3'/,
  );
  NodeAssert.doesNotMatch(mismatch.stdout, /ready at/);
});

NodeTest.test("skips a runtime that already answers the pin", (t) => {
  const home = makeHome(t);
  const runtimeDir = NodePath.join(home, "runtimes", `dsh-${PIN}`);
  const bin = NodePath.join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  NodeFS.mkdirSync(NodePath.dirname(bin), { recursive: true });
  NodeFS.writeFileSync(bin, `console.log("${PIN}");\n`);
  const marker = NodePath.join(home, "npm-was-called.txt");
  const npm = NodePath.join(home, "never-npm.sh");
  NodeFS.writeFileSync(npm, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  NodeFS.chmodSync(npm, 0o755);

  const result = runInstaller(home, { npm });

  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.match(result.stdout, new RegExp(`dsh ${PIN} already installed at`));
  NodeAssert.equal(NodeFS.existsSync(marker), false);
});
