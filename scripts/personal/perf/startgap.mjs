// Start-gap probe (hbots 1.64.2). Spawns a throwaway hbots server and, from BEFORE the spawn, fires an HTTP GET and a /ws
// upgrade every 50 ms, plus three phone-model clients (the web client's 15 s attempt timeout and 1 s base backoff ladder).
// Every request is independent (agent:false) and recorded as {kind, sentMs, doneMs, outcome}.
//   node scripts/personal/perf/startgap.mjs <releaseDir> <throwaway root> <port> [runs=1] [out.json]
// Never point it at a live data root. Env: PROBE_FAKE_CLAUDE (a fake claude binary; otherwise the Claude provider is
// disabled), PROBE_HOLD_MS (how long an unanswered request is waited for, default 15000), PROBE_HTTP_PATH, PROBE_ENV (JSON).
// Outcomes: ECONNREFUSED (port not open yet, fine), a status code / 101, TIMEOUT (never answered), RESET.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const [releaseDir, root, portArg, runsArg = "1", outJson] = process.argv.slice(2);
const port = Number(portArg);
// The probe overwrites <root>/userdata/settings.json, so it only runs against a throwaway root under the temp folder.
if (
  !releaseDir ||
  !root ||
  !portArg ||
  !NodePath.resolve(root)
    .toLowerCase()
    .startsWith(NodePath.resolve(NodeOS.tmpdir()).toLowerCase() + NodePath.sep)
) {
  console.error(
    "usage: node startgap.mjs <releaseDir> <throwaway root under the temp folder> <port> [runs] [out.json]",
  );
  process.exit(2);
}
const HOLD = Number(process.env.PROBE_HOLD_MS ?? 15000);
const FAKE = process.env.PROBE_FAKE_CLAUDE;
const HTTP_PATH = process.env.PROBE_HTTP_PATH ?? "/.well-known/t3/environment";

function writeSettings() {
  NodeFS.mkdirSync(`${root}/userdata`, { recursive: true });
  NodeFS.writeFileSync(
    `${root}/userdata/settings.json`,
    JSON.stringify({
      providers: {
        claudeAgent: FAKE ? { binaryPath: FAKE } : { enabled: false },
        codex: { enabled: false },
        opencode: { enabled: false },
        cursor: { enabled: false },
        grok: { enabled: false },
      },
    }),
  );
}

function killTree(pid) {
  try {
    NodeChildProcess.execFileSync("taskkill.exe", ["/PID", String(pid), "/F", "/T"], {
      stdio: "ignore",
    });
  } catch {}
}

async function oneRun(runIndex) {
  writeSettings();
  const out = NodeFS.openSync(`${root}/server-${runIndex}.log`, "a");
  const records = [];
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  let portOpenMs = null;
  let stop = false;

  const sendHttp = () => {
    const rec = { kind: "http", sentMs: now(), doneMs: null, outcome: null };
    records.push(rec);
    const req = NodeHttp.request(
      { host: "127.0.0.1", port, path: HTTP_PATH, method: "GET", agent: false, timeout: HOLD },
      (res) => {
        res.resume();
        res.on("end", () => {
          rec.doneMs = now();
          rec.outcome = String(res.statusCode);
        });
        res.on("error", () => {
          rec.doneMs = now();
          rec.outcome = "RESET";
        });
      },
    );
    req.on("timeout", () => {
      rec.doneMs = now();
      rec.outcome = "TIMEOUT";
      req.destroy();
    });
    req.on("error", (e) => {
      if (rec.outcome === null) {
        rec.doneMs = now();
        rec.outcome = e.code ?? e.message;
      }
    });
    req.end();
  };
  const sendWs = () => {
    const rec = { kind: "ws", sentMs: now(), doneMs: null, outcome: null };
    records.push(rec);
    const req = NodeHttp.request({
      host: "127.0.0.1",
      port,
      path: "/ws",
      method: "GET",
      agent: false,
      timeout: HOLD,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("probe-key-1234567").toString("base64"),
      },
    });
    req.on("upgrade", (res, socket) => {
      rec.doneMs = now();
      rec.outcome = "101";
      socket.destroy();
    });
    req.on("response", (res) => {
      res.resume();
      res.on("end", () => {
        rec.doneMs = now();
        rec.outcome = String(res.statusCode);
      });
      res.on("error", () => {
        rec.doneMs = now();
        rec.outcome = "RESET";
      });
    });
    req.on("timeout", () => {
      rec.doneMs = now();
      rec.outcome = "TIMEOUT";
      req.destroy();
    });
    req.on("error", (e) => {
      if (rec.outcome === null) {
        rec.doneMs = now();
        rec.outcome = e.code ?? e.message;
      }
    });
    req.end();
  };
  // Phone model: the web client's supervisor (packages/client-runtime connection/supervisor.ts): one attempt at a time,
  // 15 s establishment timeout, then retryDelayMs(failureCount, random) (ceiling 1000 * 2^(n+1), delay in its upper half).
  const phones = [0, 700, 1500].map((startAfterMs) => ({
    startAfterMs,
    attempts: [],
    successMs: null,
  }));
  const phoneRuns = phones.map((phone) =>
    (async () => {
      await new Promise((r) => setTimeout(r, phone.startAfterMs));
      for (let failures = 0; !stop && phone.successMs === null; failures += 1) {
        const a = { sentMs: now(), doneMs: null, outcome: null };
        phone.attempts.push(a);
        await new Promise((resolve) => {
          const req = NodeHttp.request(
            {
              host: "127.0.0.1",
              port,
              path: HTTP_PATH,
              method: "GET",
              agent: false,
              timeout: 15000,
            },
            (res) => {
              res.resume();
              res.on("end", () => {
                a.outcome = String(res.statusCode);
                resolve();
              });
              res.on("error", () => {
                a.outcome = "RESET";
                resolve();
              });
            },
          );
          req.on("timeout", () => {
            a.outcome = "TIMEOUT";
            req.destroy();
            resolve();
          });
          req.on("error", (e) => {
            if (a.outcome === null) {
              a.outcome = e.code ?? e.message;
              resolve();
            }
          });
          req.end();
        });
        a.doneMs = now();
        if (a.outcome === "200") {
          phone.successMs = a.doneMs;
          break;
        }
        const ceiling = Math.min(300000, 1000 * 2 ** (failures + 1));
        await new Promise((r) =>
          setTimeout(r, Math.round(ceiling / 2 + (ceiling / 2) * Math.random())),
        );
      }
    })(),
  );
  const portWatcher = (async () => {
    while (!stop && portOpenMs === null) {
      await new Promise((resolve) => {
        const s = NodeNet.connect(port, "127.0.0.1");
        s.once("connect", () => {
          if (portOpenMs === null) portOpenMs = now();
          s.destroy();
          resolve();
        });
        s.once("error", () => resolve());
      });
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  const ticker = (async () => {
    while (!stop) {
      sendHttp();
      sendWs();
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  // Spawn after the ticker started, so the first requests hit a closed port (as a reconnecting phone does).
  await new Promise((r) => setTimeout(r, 100));
  const spawnAt = now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      `${releaseDir}/dist/bin.mjs`,
      "serve",
      "--base-dir",
      root,
      "--no-browser",
      "--port",
      String(port),
    ],
    {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: {
        ...process.env,
        PERSONAL_SEED_MODEL: "claude-sonnet-5-5",
        PERSONAL_TASKS_CONCURRENCY: "5",
        T3CODE_PERSONAL_STALL_DIR: `${root}/stalls`,
        ...(process.env.PROBE_ENV ? JSON.parse(process.env.PROBE_ENV) : {}),
      },
    },
  );
  child.unref();
  const pid = child.pid;

  // Run until the first 200 on http plus 3 s (or 40 s).
  const deadline = now() + 70000;
  let firstOkAt = null;
  while (now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const ok = records.find((r) => r.kind === "http" && r.outcome === "200");
    if (ok && firstOkAt === null) firstOkAt = now();
    if (firstOkAt !== null && now() - firstOkAt > 3000 && phones.every((p) => p.successMs !== null))
      break;
  }
  stop = true;
  await Promise.all([ticker, portWatcher, ...phoneRuns]);
  // Let in-flight requests finish or time out (HOLD) so "never answered" is observed, not assumed.
  const settleDeadline = now() + HOLD + 1000;
  while (records.some((r) => r.outcome === null) && now() < settleDeadline)
    await new Promise((r) => setTimeout(r, 100));
  killTree(pid);

  const afterPort = records.filter((r) => portOpenMs !== null && r.sentMs >= portOpenMs);
  const answered = (r) =>
    r.outcome !== null &&
    r.outcome !== "TIMEOUT" &&
    r.outcome !== "RESET" &&
    r.outcome !== "ECONNRESET";
  const firstHttp200 =
    records
      .filter((r) => r.kind === "http" && r.outcome === "200")
      .map((r) => r.doneMs)
      .sort((a, b) => a - b)[0] ?? null;
  const firstWsAnswer =
    records
      .filter((r) => r.kind === "ws" && r.outcome && /^(101|4\d\d)$/.test(r.outcome))
      .map((r) => r.doneMs)
      .sort((a, b) => a - b)[0] ?? null;
  const gapRequests = afterPort.filter((r) => firstHttp200 !== null && r.sentMs < firstHttp200);
  const summary = {
    run: runIndex,
    spawnAtMs: Math.round(spawnAt),
    portOpenMs: portOpenMs === null ? null : Math.round(portOpenMs),
    firstHttp200Ms: firstHttp200 === null ? null : Math.round(firstHttp200),
    firstWsAnswerMs: firstWsAnswer === null ? null : Math.round(firstWsAnswer),
    // restart-relative (from spawn)
    portOpenFromSpawn: portOpenMs === null ? null : Math.round(portOpenMs - spawnAt),
    http200FromSpawn: firstHttp200 === null ? null : Math.round(firstHttp200 - spawnAt),
    wsFromSpawn: firstWsAnswer === null ? null : Math.round(firstWsAnswer - spawnAt),
    sentAfterPortOpen: afterPort.length,
    unansweredAfterPortOpen: afterPort.filter((r) => !answered(r)).length,
    gapRequests: gapRequests.length,
    gapHttpOutcomes: Object.fromEntries(
      Object.entries(
        gapRequests
          .filter((r) => r.kind === "http")
          .reduce((m, r) => {
            m[r.outcome] = (m[r.outcome] ?? 0) + 1;
            return m;
          }, {}),
      ),
    ),
    gapWsOutcomes: Object.fromEntries(
      Object.entries(
        gapRequests
          .filter((r) => r.kind === "ws")
          .reduce((m, r) => {
            m[r.outcome] = (m[r.outcome] ?? 0) + 1;
            return m;
          }, {}),
      ),
    ),
    phoneFromSpawn: phones.map((p) =>
      p.successMs === null ? null : Math.round(p.successMs - spawnAt),
    ),
    phoneAttempts: phones.map((p) =>
      p.attempts.map((a) => `${Math.round(a.sentMs - spawnAt)}:${a.outcome}`).join(" "),
    ),
    maxGapWaitMs: gapRequests.length
      ? Math.round(Math.max(...gapRequests.map((r) => (r.doneMs ?? now()) - r.sentMs)))
      : 0,
  };
  return { summary, records };
}

const results = [];
for (let i = 0; i < Number(runsArg); i += 1) {
  const r = await oneRun(i);
  console.log(JSON.stringify(r.summary));
  results.push(r);
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
if (outJson) NodeFS.writeFileSync(outJson, JSON.stringify(results, null, 1));
