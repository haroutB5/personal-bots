#!/usr/bin/env node
// Gate pre-step: refuse a worktree that borrows another checkout's
// node_modules by symlink. See lib/testTree.mjs for why.
//
//   node check-test-tree.mjs --package web   (relative to <repo>/apps)
//   node check-test-tree.mjs --package-dir <dir>
import path from "node:path";
import { testTreeError } from "./lib/testTree.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const args = process.argv.slice(2);
let packageDir;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--package") packageDir = path.join(repoRoot, "apps", args[(i += 1)]);
  else if (args[i] === "--package-dir") packageDir = path.resolve(args[(i += 1)]);
}
if (!packageDir) {
  console.error("usage: check-test-tree.mjs --package <app dir under apps/> | --package-dir <dir>");
  process.exit(2);
}
const error = testTreeError({ repoRoot, packageDir });
if (error !== null) {
  console.error(error);
  process.exit(2);
}
