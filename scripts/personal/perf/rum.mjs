// Summarises the real-user timings the app beacons into the server log
// (web features/personal/perfRum.ts -> POST /api/personal/client-diag).
//
//   node scripts/personal/perf/rum.mjs [--days 7] [--since 2026-09-24T00:00]
//
// Groups by journey, relay/direct and warm (a service worker controlled the
// page) vs cold, and prints n, p50 and p75 in ms.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { quantile, round } from "./lib.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const days = Number(arg("days", "7"));
const since = arg("since", null);
const logs = NodePath.join(NodeOS.homedir(), ".personal-bots", "logs");
const cutoff = Date.now() - days * 86_400_000;

const groups = new Map();
for (const name of NodeFS.readdirSync(logs)
  .filter((n) => /^server-\d{8}.*\.log$/.test(n))
  .sort()) {
  const day = name.slice(7, 15);
  const dayMs = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T23:59:59`);
  if (dayMs < cutoff) continue;
  for (const line of NodeFS.readFileSync(NodePath.join(logs, name), "utf8").split("\n")) {
    const at = line.indexOf('client-diag {"event":"perf"');
    if (at < 0) continue;
    if (since !== null) {
      const time = line.slice(1, 13);
      const stamp = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time}`;
      if (stamp < since) continue;
    }
    let record;
    try {
      record = JSON.parse(line.slice(at + "client-diag ".length));
    } catch {
      continue;
    }
    if (typeof record.ms !== "number") continue;
    const key = `${record.journey} ${record.via ?? "?"} ${record.warm ? "warm" : "cold"}${record.snapshot ? " snapshot" : ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record.ms);
  }
}
if (groups.size === 0) {
  console.log("No perf beacons yet. The phone sends them from v1.30.0 on.");
  process.exit(0);
}
console.log("journey via warmth            n     p50     p75");
for (const [key, values] of [...groups].sort()) {
  console.log(
    `${key.padEnd(28)} ${String(values.length).padStart(3)} ${String(round(quantile(values, 0.5))).padStart(7)} ${String(round(quantile(values, 0.75))).padStart(7)}`,
  );
}
