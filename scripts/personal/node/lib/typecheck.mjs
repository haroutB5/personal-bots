// Lean typecheck: run a package's tsc in shards so the peak RAM stays low.
//
// The server program (3,000 files, 3.1M types) peaks at 6.3-6.9 GiB with tsc 7's
// default 4 checkers. Checked in shards of tsconfig.typecheck-*.json, one at a
// time, with one checker and GOGC=25, each shard stays under 2.6 GiB (Optimizer,
// 26 Oct, qa/build-diet-20261026). The shards must list exactly the files of the
// package's tsconfig.json; checkCoverage proves that on every run.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SHARD_PREFIX = "tsconfig.typecheck-";

export function findShards(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(SHARD_PREFIX) && f.endsWith(".json"))
    .sort();
}

// Lean is the default; HBOTS_TYPECHECK=full is the kill switch back to one plain tsc run.
export function leanSettings(env) {
  const mode = (env.HBOTS_TYPECHECK ?? "lean").trim().toLowerCase();
  if (mode === "full") return { lean: false, env: {}, args: [] };
  if (mode !== "lean") throw new Error(`HBOTS_TYPECHECK must be lean or full, got "${mode}"`);
  const checkers = (env.HBOTS_TYPECHECK_CHECKERS ?? "1").trim();
  if (!/^[1-9][0-9]?$/.test(checkers)) throw new Error("HBOTS_TYPECHECK_CHECKERS must be 1-99");
  // A caller's own GOGC wins (Go reads it at start-up).
  return { lean: true, env: env.GOGC ? {} : { GOGC: "25" }, args: ["--checkers", checkers] };
}

// tsc --pretty false prints one diagnostic per block: a line at column 0 plus
// indented continuation lines. Shards share source files, so the same block can
// come from several shards; print each once, in first-seen order.
export function splitBlocks(text) {
  const blocks = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    if (/^\s/.test(line) && blocks.length) blocks[blocks.length - 1] += `\n${line}`;
    else blocks.push(line);
  }
  return blocks;
}

export function compareCoverage(full, shards) {
  const union = new Set(shards.flat());
  const fullSet = new Set(full);
  return {
    missing: full.filter((f) => !union.has(f)),
    extra: [...union].filter((f) => !fullSet.has(f)),
  };
}

function tscRunner(tsc, cwd, env) {
  return (args) =>
    spawnSync(tsc, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
}

function listFiles(run, project) {
  const r = run(["-p", project, "--listFilesOnly"]);
  if (r.status !== 0 && !r.stdout)
    throw new Error(`tsc --listFilesOnly -p ${project} failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

export function runTypecheck({
  cwd,
  tsc,
  env = process.env,
  out = process.stdout,
  log = process.stderr,
}) {
  const settings = leanSettings(env);
  const run = tscRunner(tsc, cwd, settings.env);
  if (!settings.lean) {
    const r = spawnSync(tsc, ["--noEmit"], { cwd, stdio: "inherit" });
    return r.status ?? 1;
  }
  const shards = findShards(cwd);
  const projects = shards.length ? shards : ["tsconfig.json"];
  if (shards.length) {
    const cov = compareCoverage(
      listFiles(run, "tsconfig.json"),
      shards.map((s) => listFiles(run, s)),
    );
    if (cov.missing.length || cov.extra.length) {
      log.write(
        `typecheck: shards do not cover tsconfig.json exactly (missing ${cov.missing.length}, extra ${cov.extra.length})\n`,
      );
      for (const f of cov.missing.slice(0, 20)) log.write(`  missing: ${f}\n`);
      for (const f of cov.extra.slice(0, 20)) log.write(`  extra: ${f}\n`);
      return 2;
    }
  }
  const seen = new Set();
  let exit = 0;
  for (const project of projects) {
    const t0 = Date.now();
    const r = run(["--noEmit", "--pretty", "false", "-p", project, ...settings.args]);
    for (const block of splitBlocks(`${r.stdout}${r.stderr}`)) {
      if (seen.has(block)) continue;
      seen.add(block);
      out.write(`${block}\n`);
    }
    const status = r.status ?? 1;
    log.write(
      `typecheck: ${path.basename(project)} exit ${status} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
    );
    if (status !== 0 && exit === 0) exit = status;
  }
  return exit;
}
