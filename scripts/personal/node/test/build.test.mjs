import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getPaths } from "../lib/paths.mjs";
import { stageRelease, missingBakedPublicConfig } from "../lib/build.mjs";
import { activeReleaseName } from "../lib/release.mjs";

function makeRepo({ env = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-build-"));
  const server = path.join(repo, "apps", "server");
  fs.mkdirSync(path.join(server, "dist", "client"), { recursive: true });
  fs.mkdirSync(path.join(server, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(server, "node_modules", "marker.txt"), "modules");
  fs.writeFileSync(path.join(server, "dist", "bin.mjs"), 'const a="https://relay.example.test"; const b="pk_test_fake";\n');
  fs.writeFileSync(path.join(server, "dist", "client", "index.html"), '<script src="/assets/index-abc123.js"></script>');
  fs.writeFileSync(path.join(server, "dist", "claude-history-worker.mjs"), "// worker\n");
  fs.mkdirSync(path.join(repo, "scripts", "personal"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "personal", "app-version.txt"), "9.9.9\n");
  if (env) {
    fs.writeFileSync(
      path.join(repo, ".env"),
      "T3CODE_RELAY_URL=https://relay.example.test\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_test_fake\n",
    );
  }
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}

test("staging copies dist, links externals and writes VERSION without activating", () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-build-home-"));
  const paths = getPaths({ home });
  const staged = stageRelease({ repoRoot: repo, paths, skipBuild: true, verifyExternals: false });
  assert.match(staged.name, /^[0-9a-f]{12}$/);
  assert.equal(fs.existsSync(path.join(staged.dir, "dist", "bin.mjs")), true);
  assert.equal(fs.lstatSync(path.join(staged.dir, "node_modules")).isSymbolicLink(), true);
  const version = fs.readFileSync(path.join(staged.dir, "VERSION"), "utf8");
  assert.match(version, /version=9\.9\.9/);
  assert.match(version, /externals=junction/);
  assert.match(version, /dirty=false/);
  const clientVersion = fs.readFileSync(path.join(staged.dir, "dist", "client", "version.txt"), "utf8");
  assert.match(clientVersion, /client=index-abc123\.js/);
  assert.equal(activeReleaseName(paths), null, "staging must not touch current.txt");
});

test("dirty trees get a unique release name", () => {
  const repo = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-build-home-"));
  const paths = getPaths({ home });
  fs.appendFileSync(path.join(repo, "apps", "server", "dist", "bin.mjs"), "// dirty\n");
  const staged = stageRelease({ repoRoot: repo, paths, skipBuild: true, verifyExternals: false });
  assert.match(staged.name, /^[0-9a-f]{12}-dirty-\d{14}$/);
});

test("a build without the public config is refused before staging", () => {
  const repo = makeRepo({ env: false });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-build-home-"));
  const paths = getPaths({ home });
  assert.throws(() => stageRelease({ repoRoot: repo, paths, skipBuild: true, verifyExternals: false }), /public config is empty/);
  assert.equal(fs.existsSync(paths.releasesDir), false);
});

test("baked config check names only missing keys", () => {
  const repo = makeRepo();
  const binPath = path.join(repo, "apps", "server", "dist", "bin.mjs");
  const missing = missingBakedPublicConfig({
    binPath,
    values: { T3CODE_RELAY_URL: "https://relay.example.test", T3CODE_CLERK_PUBLISHABLE_KEY: "pk_other" },
  });
  assert.deepEqual(missing, ["T3CODE_CLERK_PUBLISHABLE_KEY"]);
});
