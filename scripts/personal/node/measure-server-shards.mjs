#!/usr/bin/env node
// Measures the two server-tests gate shards with vitest's JSON reporter and
// merges the per-file durations into shardWeights.json. Run it through
// tools/heavy-job.sh; it starts both shard processes at once, like the gate.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const MIN_RECORDED_SECONDS = 0.5;

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    repo: { type: "string" },
  },
});
const repoRoot = values.repo ? NodePath.resolve(values.repo) : NodePath.resolve(process.cwd());
const gatesFile = NodePath.join(repoRoot, "scripts/personal/node/gates-linux.json");
const weightsFile = NodePath.join(repoRoot, "apps/server/src/testUtils/shardWeights.json");
const serverDir = NodePath.join(repoRoot, "apps/server");
const gate = JSON.parse(NodeFS.readFileSync(gatesFile, "utf8")).find(
  (entry) => entry.id === "server-tests",
);
if (!gate?.concurrent?.length) throw new Error(`No concurrent server-tests gate in ${gatesFile}`);

const workDir = NodePath.join(repoRoot, ".tmp", `shard-measure-${Date.now()}`);
NodeFS.mkdirSync(workDir, { recursive: true });

const runLane = (commands, index) =>
  new Promise((resolve) => {
    const report = NodePath.join(workDir, `shard-${index + 1}.json`);
    const started = Date.now();
    const wall = () => (Date.now() - started) / 1000;
    const next = (at) => {
      if (at >= commands.length) {
        resolve({ index, wallSeconds: wall(), exit: 0, report });
        return;
      }
      const command = commands[at].includes("vp test run")
        ? `${commands[at]} --reporter=json --outputFile=${JSON.stringify(report)}`
        : commands[at];
      const child = NodeChildProcess.spawn("bash", ["-o", "pipefail", "-c", command], {
        cwd: serverDir,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", () => resolve({ index, wallSeconds: wall(), exit: 1, report }));
      child.once("exit", (code) => {
        if (code !== 0) resolve({ index, wallSeconds: wall(), exit: code ?? 1, report });
        else next(at + 1);
      });
    };
    next(0);
  });

const lanes = await Promise.all(gate.concurrent.map((commands, index) => runLane(commands, index)));
const exists = JSON.parse(NodeFS.readFileSync(weightsFile, "utf8"));
const weights = { ...exists };
const measured = [];
for (const lane of lanes) {
  const report = JSON.parse(NodeFS.readFileSync(lane.report, "utf8"));
  lane.tests = {
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    total: report.numTotalTests,
  };
  for (const file of report.testResults ?? []) {
    const key = NodePath.relative(serverDir, file.name).replaceAll("\\", "/");
    const seconds = Math.round((file.endTime - file.startTime) / 100) / 10;
    measured.push(key);
    if (seconds >= MIN_RECORDED_SECONDS) weights[key] = seconds;
    else delete weights[key];
  }
}
const sorted = Object.fromEntries(
  Object.entries(weights).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
const summary = {
  repo: repoRoot,
  shards: lanes.map(({ index, wallSeconds, exit, tests }) => ({
    shard: index + 1,
    wallSeconds: Math.round(wallSeconds * 10) / 10,
    exit,
    tests,
  })),
  gateWallSeconds: Math.round(Math.max(...lanes.map((lane) => lane.wallSeconds)) * 10) / 10,
  filesMeasured: new Set(measured).size,
  weightsWritten: values.out ? NodePath.resolve(values.out) : null,
};
if (values.out)
  NodeFS.writeFileSync(NodePath.resolve(values.out), `${JSON.stringify(sorted, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = lanes.every((lane) => lane.exit === 0) ? 0 : 1;
