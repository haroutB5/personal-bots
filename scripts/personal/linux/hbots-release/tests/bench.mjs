// Measures arm -> verified and the runner's own CPU and RAM with the PRODUCTION constants (30 s looks, 4 quiet
// looks, 120 s stability window) on a throwaway fixture. Takes about 3 minutes. Run: node tests/bench.mjs
import fs from "node:fs";
import { makeEnv, sleep } from "./env.mjs";

const env = await makeEnv({ name: "bench", constants: { LOOK_MS: 30_000, QUIET_LOOKS: 4, EVENTS_QUIET_MS: 90_000, CPU_BUDGET_S: 0.6, MARATHON_MS: 3_600_000 } });
try {
  env.start();
  env.target();
  env.writePins();
  let r = env.runner("--prepare", ["--stable-seconds", "120"]);
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  const t0 = Date.now();
  r = env.launch(null, ["--stable-seconds", "120"]);
  console.log(r.stdout.trim());
  let j;
  for (;;) {
    await sleep(2000);
    j = env.result();
    if (["live_verified", "failed", "rolled_back", "rollback_failed"].includes(j.status)) break;
  }
  await sleep(1000);
  j = env.result();
  console.log(JSON.stringify({ status: j.status, wallSeconds: (Date.now() - t0) / 1000, armToVerified: j.timings.armToVerified, restartToVerified: j.timings.restartToVerified, restart: j.timings.restart, idleWait: j.timings["idle.wait"], runner: j.selfStats }, null, 2));
} finally {
  env.stop();
}
