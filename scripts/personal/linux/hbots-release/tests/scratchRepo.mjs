import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const SCRATCH = NodePath.join(ROOT, "../../../../.tmp");
NodeFS.mkdirSync(SCRATCH, { recursive: true });

export const git = (repo, ...args) => {
  const result = NodeChildProcess.spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

export const write = (repo, path, text) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, path), text);
};

export const commit = (repo, message) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

export function withRepo(seed, run) {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "scratch-"));
  const repo = NodePath.join(dir, "repo");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  seed(repo);
  try {
    run({ repo, trunk: commit(repo, "trunk"), dir });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

export function branch(repo, name, edit, message = name) {
  git(repo, "checkout", "-q", "-b", name, "trunk");
  edit();
  const sha = commit(repo, message);
  git(repo, "checkout", "-q", "trunk");
  return sha;
}

export const planner = (repo, base, head, ...flags) => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(ROOT, "lib/gateScope.mjs"), "--base", base, "--head", head, "--repo", repo, ...flags],
    { encoding: "utf8" },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
};
