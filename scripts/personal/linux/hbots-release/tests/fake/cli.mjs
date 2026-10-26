// Stand-in for the ops CLI's `smoke` command. Passes when server.json shows the expected release with a live
// pid that stays the same for the stability window. A file <home>/flags/fail-smoke-<release> forces a failure.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const expect = opt("expect-release");
const stable = Number(opt("stable-seconds", "2"));
const timeout = Number(opt("start-timeout", "30"));
const home = path.join(process.env.HOME, ".personal-bots");
const state = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "run", "server.json"), "utf8"));
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log("Personal Bots smoke (fixture)");
if (argv[0] !== "smoke") {
  console.log("unknown command");
  process.exit(2);
}
const deadline = Date.now() + timeout * 1000;
let s = state();
while (!(s && String(s.release) === expect && fs.existsSync(`/proc/${s.pid}`)) && Date.now() < deadline) {
  await sleep(250);
  s = state();
}
if (!s || String(s.release) !== expect) {
  console.log(`  FAIL  process: server.json release ${s?.release}, expected ${expect}`);
  console.log("Smoke FAILED.");
  process.exit(1);
}
console.log(`  ok    process pid ${s.pid}, release ${s.release}`);
const flag = path.join(home, "flags", `fail-smoke-${expect}`);
await sleep(stable * 1000);
const s2 = state();
if (fs.existsSync(flag)) {
  console.log("  FAIL  forced: fail-smoke flag present");
  console.log("Smoke FAILED.");
  process.exit(1);
}
if (!s2 || s2.pid !== s.pid) {
  console.log("  FAIL  stable: pid changed during the stability window");
  console.log("Smoke FAILED.");
  process.exit(1);
}
console.log(`  ok    stable for ${stable}s (same pid and start time)`);
console.log("Smoke PASSED.");
