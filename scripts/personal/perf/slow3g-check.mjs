// slow3g:check - compares a slow3g.mjs report with slow3g-budget.json.
//
//   node scripts/personal/perf/slow3g-check.mjs --report ~/.personal-bots/perf/slow3g-after.json
//   node scripts/personal/perf/slow3g-check.mjs --report <file> --ratchet   # lower beaten budgets
//
// Same rules as check.mjs: each budget is a ceiling on the median of the
// report's runs, it only ever goes down, and --ratchet lowers a beaten one to
// the slowest run plus headroom (so one quick run cannot set a budget the
// next ordinary run fails). `slack` is an absolute floor for small values.
// settledMs is not gated: on 3G it moves by tens of seconds with background
// polls (see README.md).
import * as NodeFS from "node:fs";

import { round } from "./lib.mjs";

const budgetFile = new URL("./slow3g-budget.json", import.meta.url);
const budget = JSON.parse(NodeFS.readFileSync(budgetFile, "utf8"));
const reportFlag = process.argv.indexOf("--report");
if (reportFlag < 0) {
  console.error("usage: slow3g-check.mjs --report <slow3g report.json> [--ratchet]");
  process.exit(2);
}
const ratchet = process.argv.includes("--ratchet");
const report = JSON.parse(NodeFS.readFileSync(process.argv[reportFlag + 1], "utf8"));

for (const key of ["downKbps", "upKbps", "rtt"]) {
  if (report.settings[key] !== budget.settings[key]) {
    console.error(
      `report ${key}=${report.settings[key]} but budgets are for ${budget.settings[key]}`,
    );
    process.exit(2);
  }
}

let failed = 0;
let lowered = 0;
for (const [scenario, metrics] of Object.entries(budget.scenarios)) {
  const summary = report.summary[scenario];
  if (!summary) {
    console.log(`FAIL ${scenario}: no data`);
    failed += 1;
    continue;
  }
  for (const [metric, rule] of Object.entries(metrics)) {
    const observed = summary[metric];
    if (observed === undefined || observed === null) continue;
    const slowest = Math.max(...report.runs.map((run) => run[scenario]?.[metric] ?? observed));
    const ok = observed <= rule.max;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${scenario}.${metric} median=${observed} budget=${rule.max} (headroom ${(rule.headroom ?? 0) * 100}%)`,
    );
    if (!ok) failed += 1;
    const candidate = round(
      Math.max(slowest * (1 + (rule.headroom ?? 0)), slowest + (rule.slack ?? 0)),
      0,
    );
    if (ratchet && ok && candidate < rule.max) {
      rule.max = candidate;
      lowered += 1;
    }
  }
}
if (ratchet && lowered > 0) {
  budget.ratchetHistory = [
    ...(budget.ratchetHistory ?? []),
    { at: budget.ratchetedAt, from: budget.ratchetedFrom },
  ];
  budget.ratchetedAt = new Date().toISOString();
  budget.ratchetedFrom = `${report.label} ${report.at}`;
  NodeFS.writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`ratchet: lowered ${lowered} budget(s); commit slow3g-budget.json with the change`);
}
console.log(failed === 0 ? "slow3g:check passed" : `slow3g:check FAILED (${failed} over budget)`);
process.exit(failed === 0 ? 0 : 1);
