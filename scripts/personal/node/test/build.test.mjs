import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { getPaths } from "../lib/paths.mjs";
import { stageRelease, missingBakedPublicConfig } from "../lib/build.mjs";
import { activeReleaseName } from "../lib/release.mjs";

function makeRepo({ env = true } = {}) {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-build-"));
  const server = NodePath.join(repo, "apps", "server");
  NodeFS.mkdirSync(NodePath.join(server, "dist", "client"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(server, "node_modules"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(server, "node_modules", "marker.txt"), "modules");
  NodeFS.writeFileSync(
    NodePath.join(server, "dist", "bin.mjs"),
    'const a="https://relay.example.test"; const b="pk_test_fake";\n',
  );
  NodeFS.writeFileSync(
    NodePath.join(server, "dist", "client", "index.html"),
    '<script src="/assets/index-abc123.js"></script>',
  );
  NodeFS.writeFileSync(NodePath.join(server, "dist", "claude-history-worker.mjs"), "// worker\n");
  NodeFS.mkdirSync(NodePath.join(repo, "scripts", "personal"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, "scripts", "personal", "app-version.txt"), "9.9.9\n");
  if (env) {
    NodeFS.writeFileSync(
      NodePath.join(repo, ".env"),
      "T3CODE_RELAY_URL=https://relay.example.test\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_test_fake\n",
    );
  }
  NodeChildProcess.spawnSync("git", ["init", "-q"], { cwd: repo });
  NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.email=t@example.test", "-c", "user.name=t", "add", "-A"],
    { cwd: repo },
  );
  NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "init"],
    { cwd: repo },
  );
  return repo;
}

NodeTest.test("staging copies dist, links externals and writes VERSION without activating", () => {
  const repo = makeRepo();
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-build-home-"));
  const paths = getPaths({ home });
  const staged = stageRelease({ repoRoot: repo, paths, skipBuild: true, verifyExternals: false });
  NodeAssert.match(staged.name, /^[0-9a-f]{12}$/);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(staged.dir, "dist", "bin.mjs")), true);
  NodeAssert.equal(
    NodeFS.lstatSync(NodePath.join(staged.dir, "node_modules")).isSymbolicLink(),
    true,
  );
  const version = NodeFS.readFileSync(NodePath.join(staged.dir, "VERSION"), "utf8");
  NodeAssert.match(version, /version=9\.9\.9/);
  NodeAssert.match(version, /externals=junction/);
  NodeAssert.match(version, /dirty=false/);
  const clientVersion = NodeFS.readFileSync(
    NodePath.join(staged.dir, "dist", "client", "version.txt"),
    "utf8",
  );
  NodeAssert.match(clientVersion, /client=index-abc123\.js/);
  NodeAssert.equal(activeReleaseName(paths), null, "staging must not touch current.txt");
});

NodeTest.test("dirty trees get a unique release name", () => {
  const repo = makeRepo();
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-build-home-"));
  const paths = getPaths({ home });
  NodeFS.appendFileSync(NodePath.join(repo, "apps", "server", "dist", "bin.mjs"), "// dirty\n");
  const staged = stageRelease({ repoRoot: repo, paths, skipBuild: true, verifyExternals: false });
  NodeAssert.match(staged.name, /^[0-9a-f]{12}-dirty-\d{14}$/);
});

NodeTest.test("a build without the public config is refused before staging", () => {
  const repo = makeRepo({ env: false });
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-build-home-"));
  const paths = getPaths({ home });
  NodeAssert.throws(
    () => stageRelease({ repoRoot: repo, paths, skipBuild: true, verifyExternals: false }),
    /public config is empty/,
  );
  NodeAssert.equal(NodeFS.existsSync(paths.releasesDir), false);
});

NodeTest.test("baked config check names only missing keys", () => {
  const repo = makeRepo();
  const binPath = NodePath.join(repo, "apps", "server", "dist", "bin.mjs");
  const missing = missingBakedPublicConfig({
    binPath,
    values: {
      T3CODE_RELAY_URL: "https://relay.example.test",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_other",
    },
  });
  NodeAssert.deepEqual(missing, ["T3CODE_CLERK_PUBLISHABLE_KEY"]);
});

NodeTest.test(
  "baked config is found in the client bundle when the server does not inline it",
  () => {
    const repo = makeRepo();
    const binPath = NodePath.join(repo, "apps", "server", "dist", "bin.mjs");
    NodeFS.writeFileSync(binPath, "// server bundle\n");
    NodeFS.mkdirSync(NodePath.join(repo, "apps", "server", "dist", "client", "assets"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(repo, "apps", "server", "dist", "client", "assets", "app.js"),
      'const a="https://relay.example.test"; const b="pk_test_fake";\n',
    );
    const missing = missingBakedPublicConfig({
      binPath,
      clientDirectory: NodePath.join(repo, "apps", "server", "dist", "client"),
      values: {
        T3CODE_RELAY_URL: "https://relay.example.test",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_fake",
      },
    });
    NodeAssert.deepEqual(missing, []);
  },
);
