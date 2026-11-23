// @effect-diagnostics nodeBuiltinImport:off - Pure-Node HTTP-over-Unix-socket client for hbots-rebootd.
/**
 * Client for the statically-linked root reboot daemon `hbots-rebootd` over its
 * local Unix domain socket (`/run/hbots-rebootd.sock` by default).
 *
 * Zero child processes, zero `libsystemd-shared`, zero disk writes.
 */
import * as NodeHttp from "node:http";

export const DEFAULT_REBOOTD_SOCKET = "/run/hbots-rebootd.sock";
export const REBOOTD_SOCKET_ENV = "HBOTS_REBOOTD_SOCKET";
export const DEFAULT_REBOOTD_TIMEOUT_MS = 5_000;

export interface RebootDaemonResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly dryRun: boolean;
  readonly daemon?: string;
  readonly watchdog?: boolean;
  readonly rebootInMs?: number;
  readonly error?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requestDaemon(
  method: "GET" | "POST",
  path: "/health" | "/reboot",
  socketPath: string,
  timeoutMs: number,
): Promise<RebootDaemonResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RebootDaemonResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const req = NodeHttp.request(
      {
        socketPath,
        path,
        method,
        headers: {
          Host: "localhost",
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (total < MAX_BODY_BYTES) {
            chunks.push(chunk);
            total += chunk.length;
          }
        });
        res.on("end", () => {
          const status = res.statusCode ?? null;
          const text = Buffer.concat(chunks).toString("utf8").trim();
          const body = text.length > 0 ? parseJsonObject(text) : null;
          const is2xx = status !== null && status >= 200 && status < 300;
          if (is2xx && body?.["ok"] === true) {
            finish({
              ok: true,
              status,
              dryRun: body["dryRun"] === true,
              ...(typeof body["daemon"] === "string" ? { daemon: body["daemon"] } : {}),
              ...(typeof body["watchdog"] === "boolean" ? { watchdog: body["watchdog"] } : {}),
              ...(typeof body["rebootInMs"] === "number" ? { rebootInMs: body["rebootInMs"] } : {}),
            });
            return;
          }
          const bodyError =
            typeof body?.["error"] === "string" && body["error"].trim().length > 0
              ? body["error"].trim()
              : null;
          finish({
            ok: false,
            status,
            dryRun: false,
            error:
              bodyError ??
              (status !== null
                ? `hbots-rebootd returned HTTP ${status}`
                : "hbots-rebootd returned an invalid response"),
          });
        });
        res.on("error", (err) => {
          finish({ ok: false, status: res.statusCode ?? null, dryRun: false, error: err.message });
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: null, dryRun: false, error: "hbots-rebootd timed out" });
    }, timeoutMs);

    req.on("error", (err) => {
      finish({ ok: false, status: null, dryRun: false, error: err.message });
    });

    req.end();
  });
}

export function resolveRebootDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[REBOOTD_SOCKET_ENV]?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_REBOOTD_SOCKET;
}

export function checkRebootDaemonHealth(
  socketPath: string = resolveRebootDaemonSocketPath(),
  timeoutMs: number = DEFAULT_REBOOTD_TIMEOUT_MS,
): Promise<RebootDaemonResult> {
  return requestDaemon("GET", "/health", socketPath, timeoutMs);
}

export function requestDaemonReboot(
  socketPath: string = resolveRebootDaemonSocketPath(),
  timeoutMs: number = DEFAULT_REBOOTD_TIMEOUT_MS,
): Promise<RebootDaemonResult> {
  return requestDaemon("POST", "/reboot", socketPath, timeoutMs);
}
