// Shared helpers for the hbots perf bench (see README.md in this folder).
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

const require = NodeModule.createRequire(
  new URL("../../../apps/desktop/package.json", import.meta.url),
);
export const { chromium } = require("playwright-core");

export const PERF_HOME = NodePath.join(NodeOS.homedir(), ".personal-bots", "perf");
NodeFS.mkdirSync(PERF_HOME, { recursive: true });

export const ORIGINS = {
  local: "http://localhost:38472",
  relay: "https://prod-3b13e30646369ab7.t3coderelay.com",
};

export function resolveOrigin(value) {
  return ORIGINS[value] ?? value;
}

/** Signed-in cookies live outside the repo: they are session secrets. */
export function authStatePath(origin) {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, "_");
  return NodePath.join(PERF_HOME, `auth-${host}.json`);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function quantile(values, q) {
  const xs = values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/** Pearson correlation; null when either side has no variance. */
export function pearson(xs, ys) {
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
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function round(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
