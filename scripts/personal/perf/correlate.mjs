// Which bench counters track wall-clock? A metric only becomes a gate once it
// is shown to move with the time the user waits (see README.md).
//
//   node scripts/personal/perf/correlate.mjs <bench.json> [more.json ...]
//
// For every journey it pools the runs of all files and prints, per counter:
//   r    Pearson correlation with wall across runs (noise-driven: machine load)
//   cv   coefficient of variation (how stable the counter is run to run)
// A deterministic counter (cv ~ 0) cannot correlate run to run; it is judged
// across builds instead (did it move when wall moved?), which the A/B output
// of bench.mjs --ab shows directly.
import * as NodeFS from "node:fs";
import { pearson, round } from "./lib.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node correlate.mjs <bench.json> [more.json ...]");
  process.exit(2);
}
const byJourney = new Map();
for (const file of files) {
  const report = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  for (const run of report.results) {
    for (const [name, value] of Object.entries(run)) {
      if (!name.startsWith("J") || typeof value !== "object") continue;
      const journey = name.split("@")[0];
      if (!byJourney.has(journey)) byJourney.set(journey, []);
      byJourney.get(journey).push(value);
    }
  }
}

const cv = (xs) => {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (mean === 0) return 0;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return sd / Math.abs(mean);
};

for (const [journey, rows] of byJourney) {
  const walls = rows.map((r) => r.wall);
  const fields = Object.keys(rows[0]).filter(
    (k) => k !== "wall" && rows.every((r) => typeof r[k] === "number" || r[k] === null),
  );
  const lines = fields
    .map((field) => {
      const values = rows.map((r) => (typeof r[field] === "number" ? r[field] : NaN));
      const finite = values.filter(Number.isFinite);
      return { field, r: pearson(values, walls), cv: cv(finite), n: finite.length };
    })
    .filter((line) => line.n >= 3)
    .sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0));
  console.log(`\n${journey} (n=${rows.length}, wall cv=${round(cv(walls), 2)})`);
  for (const line of lines) {
    const verdict =
      line.r !== null && line.r >= 0.6
        ? "tracks wall"
        : (line.cv ?? 1) < 0.05
          ? "deterministic"
          : "noise";
    console.log(
      `  ${line.field.padEnd(14)} r=${String(round(line.r, 2)).padStart(5)}  cv=${String(round(line.cv, 2)).padStart(5)}  ${verdict}`,
    );
  }
}
