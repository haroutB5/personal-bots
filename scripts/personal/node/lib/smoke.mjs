// Live smoke checks, mirroring scripts/personal/smoke.ps1. Read-only.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as proc from "./proc.mjs";

const execFileAsync = promisify(execFile);

const LOG_ERROR_PATTERN =
  /MigrationError|Migrations? failed|SqlError|no such column|no such table|SQLITE_ERROR|Defect in|FATAL/;

async function httpStatus(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const body = await response.text();
    return { status: response.status, body, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      status: null,
      body: "",
      ms: Date.now() - startedAt,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Every poll is reported so a failing limit can be judged from the codes and
// the time to the first 200 instead of a single "did not answer" line.
export async function waitHttp200(url, timeoutSeconds, { onPoll = null } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  let attempt = 0;
  let last = null;
  do {
    attempt += 1;
    const result = await httpStatus(url);
    last = result;
    onPoll?.({
      attempt,
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      status: result.status,
      error: result.error ?? null,
      requestMs: result.ms,
    });
    if (result.status === 200) return result;
    await proc.sleep(3000);
  } while (Date.now() < deadline);
  return last && last.status === 200 ? last : null;
}

function latestLog(logsDir) {
  try {
    const names = fs
      .readdirSync(logsDir)
      .filter((name) => /^server-\d{8}\.log$/.test(name))
      .sort();
    return names.length ? path.join(logsDir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

function readLogLines(file, fromByte) {
  if (fromByte >= 0) {
    const buffer = fs.readFileSync(file);
    return buffer.subarray(Math.min(fromByte, buffer.length)).toString("utf8").split(/\r?\n/);
  }
  return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-300);
}

export async function connectStatus({ nodeExe, binPath, baseDir }) {
  try {
    const { stdout } = await execFileAsync(
      nodeExe,
      [binPath, "connect", "status", "--json", "--base-dir", baseDir],
      {
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const start = stdout.indexOf("{");
    return start >= 0 ? JSON.parse(stdout.slice(start)) : null;
  } catch {
    return null;
  }
}

export async function runSmoke({
  paths,
  expectRelease = null,
  startTimeoutSeconds = 90,
  tunnelTimeoutSeconds = 90,
  stableSeconds = 120,
  noTunnel = false,
  logFile = null,
  logFromByte = -1,
  nodeExe = process.execPath,
}) {
  const lines = [];
  const failures = [];
  const pass = (text) => lines.push(`  ok    ${text}`);
  const fail = (text) => {
    lines.push(`  FAIL  ${text}`);
    failures.push(text);
  };
  lines.push("Personal Bots smoke");

  // 1. Process and release identity.
  let state = null;
  const deadline = Date.now() + startTimeoutSeconds * 1000;
  do {
    const candidate = proc.readState(paths);
    if (
      candidate &&
      proc.isServerProcess(Number(candidate.pid), candidate) &&
      (!expectRelease || String(candidate.release) === expectRelease)
    ) {
      state = candidate;
      break;
    }
    await proc.sleep(2000);
  } while (Date.now() < deadline);
  if (!state) {
    const seen = proc.readState(paths);
    fail(
      `server process serving release '${expectRelease ?? "any"}' not found within ${startTimeoutSeconds}s (recorded: ${seen ? seen.release : "none"})`,
    );
    return { ok: false, lines, failures };
  }
  pass(`process pid ${state.pid}, release ${state.release}, started ${state.startedAt}`);

  // 2. Local health.
  let runtime = null;
  const runtimeDeadline = Date.now() + startTimeoutSeconds * 1000;
  do {
    runtime = proc.runtimeState(String(state.baseDir));
    if (runtime && runtime.origin) break;
    await proc.sleep(2000);
  } while (Date.now() < runtimeDeadline);
  let localUri = null;
  if (!runtime || !runtime.origin) {
    fail("no server-runtime.json origin");
  } else {
    localUri = `${String(runtime.origin).replace(/\/+$/, "")}/.well-known/t3/environment`;
    const local = await waitHttp200(localUri, startTimeoutSeconds);
    if (local) {
      let version = "";
      try {
        version = JSON.parse(local.body).serverVersion ?? "";
      } catch {
        version = "";
      }
      pass(`local ${localUri} (t3 ${version})`);
    } else {
      fail(`local ${localUri} did not answer 200`);
    }
  }

  // 3. Relay health.
  if (!noTunnel) {
    const connect = await connectStatus({
      nodeExe,
      binPath: state.binPath,
      baseDir: state.baseDir,
    });
    const endpoint = connect && connect.endpointUrl ? String(connect.endpointUrl) : null;
    if (!endpoint) {
      fail("connect status --json has no endpointUrl");
    } else {
      const tunnelUri = `${endpoint.replace(/\/+$/, "")}/.well-known/t3/environment`;
      const tunnelPolls = [];
      const tunnel = await waitHttp200(tunnelUri, tunnelTimeoutSeconds, {
        onPoll: (poll) => {
          tunnelPolls.push(poll);
          const outcome =
            poll.status === null ? `no-response (${poll.error})` : `status ${poll.status}`;
          lines.push(
            `  poll  tunnel +${poll.elapsedSeconds.toFixed(1)}s ${outcome} (${poll.requestMs}ms)`,
          );
        },
      });
      if (tunnel) {
        const first = tunnelPolls.find((poll) => poll.status === 200);
        pass(
          `tunnel ${tunnelUri} (linked ${connect.linked}; first 200 at +${first.elapsedSeconds.toFixed(1)}s, ${tunnelPolls.length} poll(s))`,
        );
      } else {
        const seen = tunnelPolls
          .map((poll) => (poll.status === null ? `error:${poll.error}` : poll.status))
          .join(",");
        fail(
          `tunnel ${tunnelUri} did not answer 200 within ${tunnelTimeoutSeconds}s (linked ${connect.linked}, desired ${connect.desired}); statuses: ${seen || "none"}`,
        );
      }
    }
  }

  // 4. Stability window.
  const stableDeadline = Date.now() + stableSeconds * 1000;
  let stable = true;
  while (Date.now() < stableDeadline) {
    await proc.sleep(Math.min(10000, Math.max(1000, stableSeconds * 1000)));
    const now = proc.readState(paths);
    if (
      !now ||
      String(now.pid) !== String(state.pid) ||
      String(now.startedAt) !== String(state.startedAt) ||
      !proc.isServerProcess(Number(now.pid), now)
    ) {
      stable = false;
      break;
    }
  }
  if (stable && localUri && (await waitHttp200(localUri, 20))) {
    pass(`stable for ${stableSeconds}s (same pid and start time)`);
  } else {
    fail(`server restarted or stopped answering within the ${stableSeconds}s stability window`);
  }

  // 5. Log scan since the restart offset.
  const file = logFile || latestLog(paths.logsDir);
  if (file && fs.existsSync(file)) {
    const bad = readLogLines(file, logFromByte).filter((line) => LOG_ERROR_PATTERN.test(line));
    if (bad.length === 0) pass(`log ${file} has no migration/SQL errors`);
    else
      fail(
        `log ${file} has ${bad.length} migration/SQL error line(s): ${bad.slice(0, 3).join(" | ")}`,
      );
  } else {
    fail("no server log found");
  }

  return { ok: failures.length === 0, lines, failures };
}
