// J5: server cold start. Starts the built server against a throwaway data
// root (never the live one: no T3 Connect link, no routines, no bots) and
// times spawn -> first 200 from /.well-known/t3/environment, with and without
// Node's on-disk compile cache (NODE_COMPILE_CACHE).
//
//   node scripts/personal/perf/coldstart.mjs [--release <sha>] [--runs 5] [--port 38590]
//
// The first start initialises the throwaway database (migrations); it is
// not counted. Each server is stopped by the PID this script spawned
// (taskkill /T on that PID only), and the throwaway root is removed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { median, quantile, round } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null))
    .filter(Boolean),
);
const releases = NodePath.join(NodeOS.homedir(), ".personal-bots", "releases");
const release =
  args.release ?? NodeFS.readFileSync(NodePath.join(releases, "current.txt"), "utf8").trim();
const bin = NodePath.join(releases, release, "dist", "bin.mjs");
const runs = Number(args.runs ?? 5);
const port = Number(args.port ?? 38590);
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pb-coldstart-"));
const cacheDir = NodePath.join(root, "compile-cache");

async function start(useCache) {
  const env = { ...process.env };
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  if (useCache) env.NODE_COMPILE_CACHE = cacheDir;
  else delete env.NODE_COMPILE_CACHE;
  const t0 = performance.now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      bin,
      "serve",
      "--base-dir",
      NodePath.join(root, "data"),
      "--no-browser",
      "--port",
      String(port),
    ],
    { env, stdio: "ignore", windowsHide: true },
  );
  let ready = null;
  for (let i = 0; i < 1200 && ready === null; i++) {
    try {
      // A timeout: a connect attempt during startup can otherwise hang for minutes.
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) ready = performance.now() - t0;
    } catch {}
    if (ready === null) await new Promise((r) => setTimeout(r, 25));
  }
  NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1500));
  return ready;
}

try {
  console.log("release", release, "root", root);
  console.log("init (migrations, not counted):", round(await start(false)), "ms");
  // Fill the compile cache once.
  console.log("cache fill (not counted):", round(await start(true)), "ms");
  const off = [];
  const on = [];
  for (let i = 0; i < runs; i++) {
    off.push(await start(false));
    on.push(await start(true));
  }
  const fmt = (xs) =>
    `p50 ${round(median(xs))} ms, p75 ${round(quantile(xs, 0.75))} ms (${xs.map((x) => round(x)).join(", ")})`;
  console.log("no compile cache:  ", fmt(off));
  console.log("compile cache:     ", fmt(on));
} finally {
  NodeFS.rmSync(root, { recursive: true, force: true });
}
