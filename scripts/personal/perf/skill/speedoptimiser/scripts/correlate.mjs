// Which counters track wall-clock? (speedoptimiser skill)
//
//   node correlate.mjs bench-1.json [bench-2.json ...]
//
// Pools the runs of every file per journey (A/B suffixes @on/@off folded) and
// prints each counter's Pearson r with wall and its run-to-run cv.
import * as NodeFS from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node correlate.mjs <bench.json> [...]");
  process.exit(2);
}
const pearson = (xs, ys) => {
  const pairs = xs
    .map((x, i) => [x, ys[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
};
const cv = (xs) => {
  if (xs.length < 2) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  if (mean === 0) return 0;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)) / Math.abs(mean);
};
const fmt = (v) => (v === null ? " null" : v.toFixed(2).padStart(5));

const byJourney = new Map();
for (const file of files) {
  for (const run of JSON.parse(NodeFS.readFileSync(file, "utf8")).results) {
    for (const [name, value] of Object.entries(run)) {
      if (name === "error" || typeof value !== "object") continue;
      const journey = name.split("@")[0];
      if (!byJourney.has(journey)) byJourney.set(journey, []);
      byJourney.get(journey).push(value);
    }
  }
}
for (const [journey, rows] of byJourney) {
  const walls = rows.map((r) => r.wall);
  console.log(`\n${journey} (n=${rows.length}, wall cv=${fmt(cv(walls))})`);
  const fields = Object.keys(rows[0]).filter((k) => k !== "wall" && typeof rows[0][k] === "number");
  const lines = fields
    .map((field) => {
      const values = rows.map((r) => r[field]);
      return { field, r: pearson(values, walls), cv: cv(values.filter(Number.isFinite)) };
    })
    .sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0));
  for (const { field, r, cv: spread } of lines) {
    const verdict =
      r !== null && r >= 0.6 ? "tracks wall" : (spread ?? 1) < 0.05 ? "deterministic" : "noise";
    console.log(`  ${field.padEnd(16)} r=${fmt(r)}  cv=${fmt(spread)}  ${verdict}`);
  }
}
