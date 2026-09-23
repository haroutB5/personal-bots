// Budget gate and ratchet (web-perf-loop skill).
//
//   node check.mjs --config perf.config.json [--budget budget.json] [--ratchet]
//
// Runs bench.mjs, compares each journey's p50 with budget.json and exits 1 on
// a regression. --ratchet lowers every beaten budget to observed * (1 +
// headroom) (or observed + slack, whichever is larger). Budgets never go up.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const configFile = arg("config");
if (!configFile) {
  console.error(
    "usage: node check.mjs --config perf.config.json [--budget budget.json] [--ratchet]",
  );
  process.exit(2);
}
const budgetFile = arg("budget", "budget.json");
const budget = JSON.parse(NodeFS.readFileSync(budgetFile, "utf8"));
const out = `check-${Date.now()}.json`;
const benchPath = NodeURL.fileURLToPath(new URL("./bench.mjs", import.meta.url));
const bench = NodeChildProcess.spawnSync(
  process.execPath,
  [benchPath, "--config", configFile, "--runs", String(budget.runs ?? 5), "--out", out],
  { stdio: "inherit" },
);
if (bench.status !== 0) process.exit(2);
const report = JSON.parse(NodeFS.readFileSync(out, "utf8"));

let failed = 0;
let lowered = 0;
for (const [journey, metrics] of Object.entries(budget.journeys)) {
  const summary = report.summary[journey];
  if (!summary) {
    console.log(`FAIL ${journey}: not measured`);
    failed += 1;
    continue;
  }
  for (const [metric, rule] of Object.entries(metrics)) {
    const observed = summary[metric]?.p50;
    // The ratchet uses p75, so one quick run cannot set a budget that the
    // next ordinary run fails.
    const settled = summary[metric]?.p75 ?? observed;
    if (observed === undefined || observed === null) continue;
    const ok = observed <= rule.max;
    console.log(`${ok ? "ok  " : "FAIL"} ${journey}.${metric} p50=${observed} budget=${rule.max}`);
    if (!ok) failed += 1;
    const candidate = Math.round(
      Math.max(settled * (1 + (rule.headroom ?? 0)), settled + (rule.slack ?? 0)),
    );
    if (argv.includes("--ratchet") && ok && candidate < rule.max) {
      rule.max = candidate;
      lowered += 1;
    }
  }
}
if (lowered > 0) {
  budget.ratchetedAt = new Date().toISOString();
  NodeFS.writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(
    `ratchet: lowered ${lowered} budget(s); commit ${budgetFile} with the change that earned it`,
  );
}
console.log(failed === 0 ? "perf check passed" : `perf check FAILED (${failed} over budget)`);
process.exit(failed === 0 ? 0 : 1);
