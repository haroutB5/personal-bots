// @effect-diagnostics nodeBuiltinImport:off - Tests the Unix socket HTTP client against a real local Unix socket HTTP server.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { checkRebootDaemonHealth, requestDaemonReboot } from "./rebootDaemonClient.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function startMockRebootd(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
) {
  const dir = NodeFS.mkdtempSync("/tmp/hbots-rebootd-");
  const socketPath = NodePath.join(dir, "rebootd.sock");
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
}

describe("rebootDaemonClient", () => {
  it("reads GET /health from hbots-rebootd over Unix socket", async () => {
    const socketPath = await startMockRebootd((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/health");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, daemon: "hbots-rebootd", watchdog: true }));
    });
    const result = await checkRebootDaemonHealth(socketPath, 2_000);
    expect(result).toEqual({
      ok: true,
      status: 200,
      dryRun: false,
      daemon: "hbots-rebootd",
      watchdog: true,
    });
  });

  it("sends POST /reboot and parses dryRun + rebootInMs", async () => {
    const socketPath = await startMockRebootd((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/reboot");
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dryRun: true, rebootInMs: 1000 }));
    });
    const result = await requestDaemonReboot(socketPath, 2_000);
    expect(result).toEqual({
      ok: true,
      status: 202,
      dryRun: true,
      rebootInMs: 1000,
    });
  });

  it("surfaces 429 rate-limit and 500 error responses", async () => {
    const socketPath = await startMockRebootd((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "rate limited" }));
    });
    const result = await requestDaemonReboot(socketPath, 2_000);
    expect(result).toEqual({
      ok: false,
      status: 429,
      dryRun: false,
      error: "rate limited",
    });
  });

  it("handles missing socket and timeouts cleanly", async () => {
    const missing = await checkRebootDaemonHealth(
      NodePath.join(NodeOS.tmpdir(), "nonexistent-rebootd.sock"),
      1_000,
    );
    expect(missing.ok).toBe(false);
    expect(missing.status).toBeNull();

    const slowSocket = await startMockRebootd(() => {
      // Intentionally never respond
    });
    const timedOut = await requestDaemonReboot(slowSocket, 80);
    expect(timedOut).toEqual({
      ok: false,
      status: null,
      dryRun: false,
      error: "hbots-rebootd timed out",
    });
  });
});
