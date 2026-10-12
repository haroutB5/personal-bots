// Reads a throwaway server log and summarises its event-loop stalls (the
// stall recorder's "event loop stall captured" WARN blocks), for the 1.66.33
// before/after checks. Prints a table and, with --json, the summary.
//
// The targeted classes are the ones the release fixes: synchronous PATH walks
// (statSync / path.normalize from CLI resolution), spawn (CreateProcess cost)
// and the plain stat class. A walk or spawn stall at or over 1 s in the run is
// a FAIL for the release check.
//
// Usage: node stall-report.mjs <server.log> [--json]
import * as NodeFS from "node:fs";

const args = process.argv.slice(2);
const logPath = args.find((arg) => !arg.startsWith("--"));
if (!logPath) throw new Error("usage: node stall-report.mjs <server.log> [--json]");

const text = NodeFS.readFileSync(logPath, "utf8");
const stalls = [];
const marker = /event loop stall captured\s*\{([^}]*)\}/g;
for (const match of text.matchAll(marker)) {
  const body = match[1];
  const field = (name) => {
    const found = new RegExp(`${name}:\\s*'?([^',\\n]+)'?`).exec(body);
    return found ? found[1].trim() : "";
  };
  const durationMs = Number(field("durationMs"));
  if (!Number.isFinite(durationMs)) continue;
  stalls.push({
    durationMs,
    cause: field("cause"),
    detail: field("detail"),
    topFrame: field("topFrame"),
  });
}

const WALK =
  /statSync|normalize \(node:path|\bstat \(node:fs|readdirSync|resolveSpawnExecutableWithNode/;
const SPAWN = /\bspawn\b/;

const classify = (stall) => {
  const haystack = `${stall.detail} ${stall.topFrame}`;
  if (stall.cause === "javascript" && WALK.test(haystack)) return "walk";
  if (stall.cause === "javascript" && SPAWN.test(haystack)) return "spawn";
  if (stall.cause === "sqlite-statement") return "sqlite";
  if (stall.cause === "file-write") return "file-write";
  if (stall.cause === "garbage-collection") return "gc";
  if (stall.cause === "process-paused") return "paused";
  return "other-js";
};

const summary = {
  log: logPath,
  stalls: stalls.length,
  totalMs: stalls.reduce((total, stall) => total + stall.durationMs, 0),
  maxMs: stalls.reduce((max, stall) => Math.max(max, stall.durationMs), 0),
  byClass: {},
  targetedOver1s: 0,
  worst: stalls.toSorted((a, b) => b.durationMs - a.durationMs).slice(0, 8),
};
for (const stall of stalls) {
  const kind = classify(stall);
  const entry = summary.byClass[kind] ?? { count: 0, totalMs: 0, maxMs: 0 };
  entry.count += 1;
  entry.totalMs += stall.durationMs;
  entry.maxMs = Math.max(entry.maxMs, stall.durationMs);
  summary.byClass[kind] = entry;
  if ((kind === "walk" || kind === "spawn") && stall.durationMs >= 1000)
    summary.targetedOver1s += 1;
}

if (args.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
console.log(
  `${logPath}: ${summary.stalls} stalls, ${(summary.totalMs / 1000).toFixed(1)}s total, max ${summary.maxMs}ms`,
);
for (const [kind, entry] of Object.entries(summary.byClass).toSorted(
  (a, b) => b[1].totalMs - a[1].totalMs,
)) {
  console.log(
    `  ${kind.padEnd(12)} count ${String(entry.count).padStart(3)}  total ${(entry.totalMs / 1000).toFixed(1).padStart(6)}s  max ${entry.maxMs}ms`,
  );
}
console.log(`  targeted (walk/spawn) stalls >= 1s: ${summary.targetedOver1s}`);
for (const stall of summary.worst) {
  console.log(`  worst ${stall.durationMs}ms ${stall.cause}: ${stall.detail.slice(0, 120)}`);
}
