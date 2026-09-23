// perf:check - runs the bench and fails when a gated metric is over budget.
//
//   node scripts/personal/perf/check.mjs            # check (exit 1 on a regression)
//   node scripts/personal/perf/check.mjs --ratchet  # check, then lower budgets that were beaten
//
// budget.json holds, per journey, the p50 ceiling of each gated metric plus
// the bench settings it was measured with. Budgets only ever go down: an
// accepted win is locked in by --ratchet, and anything that gives it back
// fails the check. Wall-clock ceilings carry headroom because this laptop's
// load moves them (see README.md, "Which metrics gate"); deterministic
// counters (requests, JS bytes, React commits) are tight.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { PERF_HOME, round } from "./lib.mjs";

const budgetFile = new URL("./budget.json", import.meta.url);
const budget = JSON.parse(NodeFS.readFileSync(budgetFile, "utf8"));
const ratchet = process.argv.includes("--ratchet");
const out = NodePath.join(PERF_HOME, `check-${Date.now()}.json`);
const benchArgs = [
  new URL("./bench.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  "--origin",
  budget.settings.origin,
  "--runs",
  String(budget.settings.runs),
  "--journeys",
  budget.settings.journeys,
  "--cpu",
  String(budget.settings.cpu),
  "--out",
  out,
  ...(budget.settings.bot ? ["--bot", budget.settings.bot] : []),
];
const bench = NodeChildProcess.spawnSync(process.execPath, benchArgs, { stdio: "inherit" });
if (bench.status !== 0) {
  console.error("bench failed");
  process.exit(2);
}
const report = JSON.parse(NodeFS.readFileSync(out, "utf8"));

let failed = 0;
let lowered = 0;
for (const [journey, metrics] of Object.entries(budget.journeys)) {
  const summary = report.summary[journey];
  if (!summary) {
    console.log(`FAIL ${journey}: no data`);
    failed += 1;
    continue;
  }
  for (const [metric, rule] of Object.entries(metrics)) {
    const observed = summary[metric]?.p50;
    if (observed === undefined || observed === null) continue;
    const ok = observed <= rule.max;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${journey}.${metric} p50=${observed} budget=${rule.max}${rule.headroom ? ` (headroom ${rule.headroom * 100}%)` : ""}`,
    );
    if (!ok) failed += 1;
    // Ratchet: a budget beaten by more than its headroom moves down to the
    // observed value plus headroom. Never up.
    const candidate = round(observed * (1 + (rule.headroom ?? 0)), 0);
    if (ratchet && ok && candidate < rule.max) {
      rule.max = candidate;
      lowered += 1;
    }
  }
}
if (ratchet && lowered > 0) {
  budget.ratchetedAt = new Date().toISOString();
  budget.ratchetedFrom = report.version;
  NodeFS.writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(
    `ratchet: lowered ${lowered} budget(s); commit budget.json with the change that earned it`,
  );
}
console.log(failed === 0 ? "perf:check passed" : `perf:check FAILED (${failed} over budget)`);
process.exit(failed === 0 ? 0 : 1);
