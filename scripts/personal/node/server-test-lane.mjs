#!/usr/bin/env node
// Runs the server tests with the Vitest worker reused across files (--no-isolate), except for the
// files in server-isolated-tests.txt, which run in their own isolated lane. Fork-owned: it keeps
// upstream's apps/server/vite.config.ts untouched.
//   node server-test-lane.mjs <all|reuse|isolated> [vp test run args...]   (run from apps/server)
// `all` runs reuse, then isolated, and fails if either fails. Every flag (--shard=i/n) goes to both
// lanes, so the shards of the isolated list are disjoint like the shards of the rest.
// SERVER_TEST_REUSE=0 runs one plain isolated `vp test run`, the pre-trial behaviour.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const ISOLATED_LIST = NodePath.join(here, "server-isolated-tests.txt");

export function parseList(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/** The `vp` argument lists to run, in order. Pure. */
export function planLane(mode, args, isolated, { reuse = true } = {}) {
  if (!["all", "reuse", "isolated"].includes(mode)) throw new Error(`unknown lane ${mode}`);
  const flags = args.filter((arg) => arg.startsWith("-"));
  const filters = args.filter((arg) => !arg.startsWith("-"));
  if (!reuse) return mode === "reuse" ? [] : [["test", "run", ...args]];
  const reuseRun = [
    "test",
    "run",
    "--no-isolate",
    ...isolated.flatMap((file) => ["--exclude", file]),
    ...args,
  ];
  // A filter is a path substring, as in vitest: a directory, a file, or nothing (all files).
  const picked = isolated.filter(
    (file) => filters.length === 0 || filters.some((filter) => file.includes(filter)),
  );
  const isolatedRun = picked.length > 0 ? [["test", "run", ...flags, ...picked]] : [];
  return [...(mode === "isolated" ? [] : [reuseRun]), ...(mode === "reuse" ? [] : isolatedRun)];
}

function main() {
  const [mode = "all", ...args] = process.argv.slice(2);
  const isolated = parseList(NodeFS.readFileSync(ISOLATED_LIST, "utf8"));
  const runs = planLane(mode, args, isolated, { reuse: process.env.SERVER_TEST_REUSE !== "0" });
  let exit = 0;
  for (const run of runs) {
    const done = NodeChildProcess.spawnSync("vp", run, { stdio: "inherit" });
    if (done.error) throw done.error;
    exit = exit || (done.status ?? 1);
  }
  process.exit(exit);
}

if (process.argv[1] && NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]))
  main();
