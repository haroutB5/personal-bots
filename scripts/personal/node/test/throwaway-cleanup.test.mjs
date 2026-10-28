import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THROWAWAY = path.join(HERE, "..", "throwaway.mjs");
const ROOT_PREFIX = "hbots-tw-";
let sequence = 0;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrpOf(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return null;
  }
}

function groupPids(pgid) {
  return fs
    .readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => pgrpOf(pid) === pgid);
}

async function eventually(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) resolve(buffer.slice(0, end));
    });
    stream.once("error", reject);
  });
}

// One detached leader with two root-named children, the shape a throwaway
// server has while fake Claude CLIs run.
async function spawnTree(root) {
  const script = `
const { spawn } = require("node:child_process");
const root = process.argv[1];
const fake = root + "/fake/fakeok/claude";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", fake], { stdio: "ignore" });
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", fake], { stdio: "ignore" });
console.log(JSON.stringify({ leader: process.pid, child: child.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;
  const leader = spawn(process.execPath, ["-e", script, root], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const line = await firstLine(leader.stdout);
  return { leader: leader.pid, ...JSON.parse(line) };
}

function makeName() {
  sequence += 1;
  return `cleanup-${process.pid}-${sequence}`;
}

function writeRecord({ name, root, pid, pgid }) {
  fs.writeFileSync(
    path.join(root, "throwaway.json"),
    `${JSON.stringify(
      {
        name,
        root,
        port: 1,
        pid,
        pgid,
        bin: process.execPath,
        node: process.execPath,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

// Async on purpose: the leader is this test's child, and a synchronous spawn
// would block the event loop so its killed process stayed a zombie (which
// kill(pid, 0) still reports as alive) until the stop command gave up.
function stop(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [THROWAWAY, "stop", "--name", name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => resolve({ status: 1, stdout, stderr: String(error) }));
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function killCaptured(pids) {
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

test("stop kills an orphaned process group after the leader crashed", async (t) => {
  const name = makeName();
  const root = path.join(os.tmpdir(), ROOT_PREFIX + name);
  fs.mkdirSync(root, { recursive: true });
  const tree = await spawnTree(root);
  // A harness (the e2e runner) names the root in --root but is not part of the
  // throwaway tree; the cleanup must leave it alive.
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", root], {
    stdio: "ignore",
  });
  const captured = [tree.leader, tree.child, tree.grandchild, helper.pid];
  t.after(() => {
    killCaptured(captured);
    fs.rmSync(root, { recursive: true, force: true });
  });

  writeRecord({ name, root, pid: tree.leader, pgid: tree.leader });
  assert.equal(pgrpOf(tree.child), tree.leader, "children start in the leader's group");

  // The crash: the leader dies, its fake CLIs and grandchildren keep running.
  process.kill(tree.leader, "SIGKILL");
  assert.ok(await eventually(() => !alive(tree.leader)));
  assert.ok(alive(tree.child), "the fake CLI is orphaned but alive");
  assert.ok(alive(tree.grandchild), "the grandchild is orphaned but alive");

  const result = await stop(name);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /stopped the orphaned process group/);
  assert.ok(await eventually(() => captured.slice(0, 3).every((pid) => !alive(pid))));
  assert.ok(alive(helper.pid), "a helper that only names the root survives");
  assert.deepEqual(groupPids(tree.leader), []);
  assert.equal(fs.existsSync(root), false, "the root is deleted only after the tree is gone");
});

test("stop kills a live leader's whole group before deleting the root", async (t) => {
  const name = makeName();
  const root = path.join(os.tmpdir(), ROOT_PREFIX + name);
  fs.mkdirSync(root, { recursive: true });
  const tree = await spawnTree(root);
  const captured = [tree.leader, tree.child, tree.grandchild];
  t.after(() => {
    killCaptured(captured);
    fs.rmSync(root, { recursive: true, force: true });
  });

  writeRecord({ name, root, pid: tree.leader, pgid: tree.leader });
  const result = await stop(name);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /stopped PID .* and its process group/);
  assert.ok(await eventually(() => captured.every((pid) => !alive(pid))));
  assert.deepEqual(groupPids(tree.leader), []);
  assert.equal(fs.existsSync(root), false);
});
