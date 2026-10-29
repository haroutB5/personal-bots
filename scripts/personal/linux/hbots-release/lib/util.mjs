// Small shared helpers: logging, the result file, step timings, child processes, hashing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const round1 = (n) => Math.round(n * 10) / 10;

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Logger plus the result file for one run. */
export function makeRun({ mode, logFile, resultFile, initial }) {
  const timings = {};
  const result = { ...initial, status: "starting", timings };
  const echo = mode !== "run";
  const note = (text) => {
    const line = `[${new Date().toISOString()}] ${text}`;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {}
    if (echo) process.stdout.write(`${text}\n`);
  };
  const save = (status, extra) => {
    if (extra) Object.assign(result, extra);
    if (status) result.status = status;
    result.updatedAt = new Date().toISOString();
    atomicWrite(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  };
  const step = async (name, body) => {
    const t0 = process.hrtime.bigint();
    try {
      return await body();
    } finally {
      timings[name] = round1(Number(process.hrtime.bigint() - t0) / 1e9);
      note(`step ${name}: ${timings[name]} s`);
    }
  };
  return { result, timings, note, save, step, logFile, resultFile };
}

/** Synchronous child. Returns { code, out, err }. */
export function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: r.status ?? (r.error ? 127 : 1), out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), signal: r.signal };
}

/** Background priority for checks and copies: CPU nice 10, idle I/O class. Falls back to plain nice. */
export function lowPriority(cmd, args) {
  return ["nice", ["-n", "10", "ionice", "-c", "3", cmd, ...args]];
}

/** Async child with captured output, run at background priority when asked. */
export function runAsync(cmd, args, { low = false, input, timeoutMs = 30 * 60_000, env, cwd, onSpawn } = {}) {
  const [bin, binArgs] = low ? lowPriority(cmd, args) : [cmd, args];
  return new Promise((resolve) => {
    const child = spawn(bin, binArgs, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
    onSpawn?.(child);
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out, err: `${err}${e.message}`.trim() });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.trim(), err: err.trim(), signal });
    });
    child.stdin.end(input ?? "");
  });
}

export function systemctl(args, timeout = 180_000) {
  const r = run("systemctl", ["--user", ...args], { timeout });
  return { code: r.code, out: `${r.out}\n${r.err}`.trim() };
}

export function errMsg(error) {
  return String(error?.message ?? error);
}
