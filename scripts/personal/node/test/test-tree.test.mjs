import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTestTree, testTreeError } from "../lib/testTree.mjs";

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePackage(dir, name) {
  fs.mkdirSync(path.join(dir, "src", "device"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({
      name,
      exports: { "./device/stream": "./src/device/stream.ts" },
    })}\n`,
  );
  fs.writeFileSync(path.join(dir, "src", "device", "stream.ts"), "export {};\n");
}

// A clean checkout: real node_modules, with the workspace package linked
// inside this root.
function cleanWorkspace() {
  const root = temp("hbots-tt-root-");
  const pkg = path.join(root, "packages", "client-runtime");
  writePackage(pkg, "@t3tools/client-runtime");
  fs.mkdirSync(path.join(root, "node_modules", "@t3tools"), { recursive: true });
  fs.symlinkSync(
    "../../packages/client-runtime",
    path.join(root, "node_modules", "@t3tools", "client-runtime"),
    "dir",
  );
  const web = path.join(root, "apps", "web");
  fs.mkdirSync(path.join(web, "node_modules"), { recursive: true });
  return { root, web };
}

test("a checkout with its own node_modules passes", (t) => {
  const { root, web } = cleanWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkTestTree({ repoRoot: root, packageDir: web }), []);
  assert.equal(testTreeError({ repoRoot: root, packageDir: web }), null);
});

test("a root node_modules borrowed from another worktree is refused", (t) => {
  const { root, web } = cleanWorkspace();
  const other = temp("hbots-tt-other-");
  t.after(() => {
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(other, "node_modules"), { recursive: true });
  fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(path.join(other, "node_modules"), path.join(root, "node_modules"), "dir");

  const problems = checkTestTree({ repoRoot: root, packageDir: web });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /symlink to .*hbots-tt-other-/);
  const message = testTreeError({ repoRoot: root, packageDir: web });
  assert.match(message, /borrows another checkout/);
  assert.match(message, /`vp i` in this worktree/);
});

test("an app-level node_modules borrowed from another worktree is refused", (t) => {
  const { root, web } = cleanWorkspace();
  const other = temp("hbots-tt-other-");
  t.after(() => {
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(other, "web-modules"), { recursive: true });
  fs.rmSync(path.join(web, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(path.join(other, "web-modules"), path.join(web, "node_modules"), "dir");

  const problems = checkTestTree({ repoRoot: root, packageDir: web });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/web\/node_modules is a symlink/);
});

test("a workspace package resolving outside the checkout is refused", (t) => {
  const { root, web } = cleanWorkspace();
  const other = temp("hbots-tt-other-");
  t.after(() => {
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const outside = path.join(other, "packages", "client-runtime");
  writePackage(outside, "@t3tools/client-runtime");
  fs.rmSync(path.join(root, "node_modules", "@t3tools", "client-runtime"));
  fs.symlinkSync(outside, path.join(root, "node_modules", "@t3tools", "client-runtime"), "dir");

  const problems = checkTestTree({ repoRoot: root, packageDir: web });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /resolves to .*hbots-tt-other-/);
  assert.match(problems[0], /outside this checkout/);
});
