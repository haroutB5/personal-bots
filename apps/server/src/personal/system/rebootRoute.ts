// @effect-diagnostics nodeBuiltinImport:off - reboot uses Unix sockets (hbots-rebootd + direct D-Bus), startup-cached rescue token read, sha256 credential cache, and busctl only as last-resort fallback.
/**
 * `/api/personal/system/reboot`: the owner restarts the laptop from the phone.
 *
 * This is the way out when SQLite, the disk, or libsystemd-shared has failed
 * (1.67.50: an SQLITE_IOERR turned the drive read-only; 23 Nov 2026: a RAM bit
 * flip in libsystemd-shared page cache made busctl/systemctl/systemd-run
 * segfault while Node stayed alive), so the whole path stays free of DB writes,
 * per-request disk reads, and child processes:
 *
 * - Auth is the session store's own `verify`, which only reads the
 *   `auth_sessions` row. It does not go through `EnvironmentAuth`, because the
 *   DPoP check there records each proof's jti as a file in the secret store; the
 *   replay check here is an in-memory set instead.
 * - Every owner credential that passes is remembered in memory (a sha256 of the
 *   token, its expiry and its DPoP key). When the session read fails for an
 *   internal reason (the database is broken), a remembered, unexpired
 *   credential still passes; an unknown one gets 503. A credential the store
 *   positively rejects (revoked, expired, bad signature) is forgotten. The phone
 *   GETs this path on WebSocket connect and when Settings opens, warming the
 *   memory and caching the optional out-of-band rescue config.
 * - Reboot execution is layered with zero `busctl` dependency on the primary
 *   paths:
 *     1. `hbots-rebootd` Unix socket (`/run/hbots-rebootd.sock`)
 *     2. Direct pure-Node.js D-Bus over `/run/dbus/system_bus_socket`
 *     3. `busctl` (`execFileRunner`) only if both socket paths fail
 * - Optional out-of-band rescue config (`HBOTS_RESCUE_REBOOT_URL` +
 *   `HBOTS_RESCUE_REBOOT_TOKEN_FILE`) is loaded ONCE at startup into RAM and
 *   handed out on `GET` only to verified owner sessions.
 *
 * Only native owner credentials pass: `Bearer` or `DPoP` with
 * `environment:maintain`, the scope the phone's pairing grants and bots never
 * hold. MCP client sessions are refused by subject, and a bot's MCP token is not
 * a signed session token at all, so `verify` rejects it. There is no MCP tool
 * for this.
 *
 * `HBOTS_REBOOT_DRY_RUN=1` (read per request) keeps everything but the final
 * Reboot call, logging "would reboot" instead.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as SessionStore from "../../auth/SessionStore.ts";
import { requestUrl } from "../../requestUrl.ts";
import {
  directDbusCanReboot,
  directDbusReboot,
  type DirectDbusCanRebootResult,
  type DirectDbusRebootResult,
} from "./directDbusReboot.ts";
import {
  checkRebootDaemonHealth,
  requestDaemonReboot,
  type RebootDaemonResult,
} from "./rebootDaemonClient.ts";

export const PERSONAL_SYSTEM_REBOOT_PATH = "/api/personal/system/reboot";
/** The reply goes out first; reboot is asked this long after. */
export const REBOOT_DELAY_MS = 1_000;
/** One accepted restart per this window, in memory. */
export const REBOOT_RATE_LIMIT_MS = 60_000;
export const REBOOT_DRY_RUN_ENV = "HBOTS_REBOOT_DRY_RUN";
export const RESCUE_REBOOT_URL_ENV = "HBOTS_RESCUE_REBOOT_URL";
export const RESCUE_REBOOT_TOKEN_FILE_ENV = "HBOTS_RESCUE_REBOOT_TOKEN_FILE";
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_REMEMBERED_CREDENTIALS = 32;
const MAX_REMEMBERED_PROOFS = 512;
/** Matches the session store's DPoP window: a proof is no use after this. */
const PROOF_MEMORY_MS = 10 * 60_000;
const MCP_CLIENT_SUBJECT = "mcp-client";

const LOGIND = [
  "busctl",
  "--system",
  "call",
  "org.freedesktop.login1",
  "/org/freedesktop/login1",
  "org.freedesktop.login1.Manager",
] as const;
export const CAN_REBOOT_ARGV: ReadonlyArray<string> = [...LOGIND, "CanReboot"];
export const REBOOT_ARGV: ReadonlyArray<string> = [...LOGIND, "Reboot", "b", "false"];

export type RebootTransport = "rebootd" | "dbus" | "busctl";

export interface RescueRebootConfig {
  readonly url: string;
  readonly token: string;
}

export interface RebootCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a fixed argv with no shell. Injected so tests never touch logind. */
export type RebootCommandRunner = (argv: ReadonlyArray<string>) => Promise<RebootCommandResult>;

export const execFileRunner: RebootCommandRunner = (argv) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      resolve({ exitCode: 127, stdout: "", stderr: "empty command" });
      return;
    }
    NodeChildProcess.execFile(
      file,
      args,
      { timeout: COMMAND_TIMEOUT_MS, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : 1;
        resolve({
          exitCode: code,
          stdout: String(stdout),
          stderr: String(stderr || (error === null ? "" : error.message)),
        });
      },
    );
  });

/**
 * Loads the optional out-of-band rescue reboot config ONCE at startup so
 * requests never touch the disk (surviving read-only / failing storage).
 * Strictly requires an `https://` URL and a non-empty token.
 */
export function loadRescueRebootConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string = (p, enc) =>
    NodeFS.readFileSync(p, enc),
): RescueRebootConfig | null {
  const rawUrl = env[RESCUE_REBOOT_URL_ENV]?.trim();
  if (!rawUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    return null;
  }

  const configuredTokenFile = env[RESCUE_REBOOT_TOKEN_FILE_ENV]?.trim();
  const defaultBaseDir =
    env["T3_STATE_DIR"]?.trim() ||
    env["T3_HOME"]?.trim() ||
    NodePath.join(NodeOS.homedir(), ".personal-bots", "dev");
  const tokenFile =
    configuredTokenFile && configuredTokenFile.length > 0
      ? configuredTokenFile
      : NodePath.join(defaultBaseDir, "userdata", "secrets", "reboot-rescue-token");

  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token.length === 0) return null;
    return { url: parsed.toString(), token };
  } catch {
    return null;
  }
}

export interface RebootRouteDeps {
  readonly checkRebootDaemon?: () => Promise<RebootDaemonResult>;
  readonly requestRebootDaemon?: () => Promise<RebootDaemonResult>;
  readonly dbusCanReboot?: () => Promise<DirectDbusCanRebootResult>;
  readonly dbusReboot?: () => Promise<DirectDbusRebootResult>;
  readonly run?: RebootCommandRunner;
  /** Optional override for tests; when omitted, loaded once from env at layer creation. */
  readonly rescueConfig?: RescueRebootConfig | null;
  readonly dryRun: () => boolean;
  readonly nowMs: () => number;
  readonly schedule: (task: () => void, delayMs: number) => void;
  readonly log: (line: string) => void;
}

export const liveRebootRouteDeps: RebootRouteDeps = {
  checkRebootDaemon: () => checkRebootDaemonHealth(),
  requestRebootDaemon: () => requestDaemonReboot(),
  dbusCanReboot: () => directDbusCanReboot(),
  dbusReboot: () => directDbusReboot(),
  run: execFileRunner,
  dryRun: () => process.env[REBOOT_DRY_RUN_ENV] === "1",
  nowMs: () => Date.now(),
  schedule: (task, delayMs) => {
    setTimeout(task, delayMs);
  },
  // stdout only: under systemd it lands in the journal, and it never needs the disk to be writable.
  log: (line) => console.log(`[hbots] reboot: ${line}`),
};

/** busctl prints `s "yes"`; anything else is returned as the raw text. */
export function parseCanReboot(stdout: string): string | null {
  const match = /^s\s+"([^"]*)"\s*$/.exec(stdout.trim());
  return match?.[1] ?? null;
}

const commandFailureText = (result: RebootCommandResult): string => {
  const text = (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, " ");
  return text.length > 0 ? text.slice(0, 300) : `busctl exited with ${result.exitCode}`;
};

export type RebootPreflight =
  | { readonly ok: true; readonly canReboot: string; readonly transport: RebootTransport }
  | { readonly ok: false; readonly canReboot: string | null; readonly error: string };

export async function rebootPreflight(run: RebootCommandRunner): Promise<RebootPreflight> {
  const result = await run(CAN_REBOOT_ARGV);
  if (result.exitCode !== 0) {
    return { ok: false, canReboot: null, error: `logind refused: ${commandFailureText(result)}` };
  }
  const answer = parseCanReboot(result.stdout);
  if (answer === null) {
    return {
      ok: false,
      canReboot: null,
      error: `logind gave an answer this server does not understand: ${commandFailureText(result)}`,
    };
  }
  if (answer !== "yes") {
    return {
      ok: false,
      canReboot: answer,
      error: `logind refused: CanReboot is "${answer}", so this user cannot restart the laptop without a password.`,
    };
  }
  return { ok: true, canReboot: answer, transport: "busctl" };
}

async function layeredPreflight(deps: RebootRouteDeps): Promise<RebootPreflight> {
  let lastFailure: string | null = null;

  // Tier 1: hbots-rebootd Unix socket (zero logind, zero busctl).
  if (deps.checkRebootDaemon !== undefined) {
    const health = await deps.checkRebootDaemon();
    if (health.ok) {
      return { ok: true, canReboot: "yes", transport: "rebootd" };
    }
    if (health.error) lastFailure = `hbots-rebootd unavailable: ${health.error}`;
  }

  // Tier 2: pure-Node direct D-Bus over /run/dbus/system_bus_socket (zero busctl).
  if (deps.dbusCanReboot !== undefined) {
    const dbus = await deps.dbusCanReboot();
    if (dbus.ok) {
      if (dbus.answer === "yes") {
        return { ok: true, canReboot: "yes", transport: "dbus" };
      }
      return {
        ok: false,
        canReboot: dbus.answer,
        error: `logind refused: CanReboot is "${dbus.answer}", so this user cannot restart the laptop without a password.`,
      };
    }
    lastFailure = `D-Bus CanReboot failed: ${dbus.error}`;
  }

  // Tier 3: busctl fallback (only if both socket paths are absent or failed).
  if (deps.run !== undefined) {
    return rebootPreflight(deps.run);
  }

  return {
    ok: false,
    canReboot: null,
    error: lastFailure ?? "No reboot transport is available on this laptop.",
  };
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.json(body, { status, headers: HEADERS }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("Internal Server Error", { status: 500, headers: HEADERS }),
    ),
  );

const refuse = (status: number, error: string) => json(status, { ok: false, error });

interface RememberedCredential {
  readonly sessionId: string;
  readonly expiresAtMs: number;
  readonly proofKeyThumbprint: string | undefined;
}

type AuthOutcome =
  | { readonly ok: true; readonly sessionId: string; readonly remembered: boolean }
  | { readonly ok: false; readonly status: number; readonly error: string };

const tokenKey = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

/**
 * The route factory. Its memory (credentials, DPoP proofs, rate limit, last
 * failure, startup-cached rescue config) belongs to the returned layer, so each
 * test gets its own.
 */
export const makePersonalSystemRebootRouteLayer = (deps: RebootRouteDeps = liveRebootRouteDeps) => {
  // Read rescue config ONCE at startup into RAM (never reading disk on request).
  const rescueConfig: RescueRebootConfig | null =
    deps.rescueConfig !== undefined ? deps.rescueConfig : loadRescueRebootConfigFromEnv();

  const credentials = new Map<string, RememberedCredential>();
  const seenProofs = new Map<string, number>();
  let lastAcceptedAtMs: number | null = null;
  let lastError: string | null = null;

  const remember = (key: string, credential: RememberedCredential) => {
    credentials.delete(key);
    credentials.set(key, credential);
    while (credentials.size > MAX_REMEMBERED_CREDENTIALS) {
      const oldest = credentials.keys().next().value;
      if (oldest === undefined) break;
      credentials.delete(oldest);
    }
  };

  /** Checks the DPoP proof, with replay tracked in memory instead of the secret store. */
  const checkProof = (
    request: HttpServerRequest.HttpServerRequest,
    token: string,
    thumbprint: string,
  ): string | null => {
    const url = requestUrl(request);
    if (Option.isNone(url)) return "Invalid request URL.";
    const nowMs = deps.nowMs();
    const result = verifyDpopProof({
      proof: request.headers.dpop,
      method: request.method,
      url: url.value.href,
      nowEpochSeconds: Math.floor(nowMs / 1_000),
      expectedThumbprint: thumbprint,
      expectedAccessToken: token,
    });
    if (!result.ok) return result.reason;
    for (const [jti, seenAt] of seenProofs) {
      if (nowMs - seenAt > PROOF_MEMORY_MS) seenProofs.delete(jti);
    }
    const replayKey = `${result.thumbprint}:${result.jti}`;
    if (seenProofs.has(replayKey)) return "DPoP proof replayed.";
    seenProofs.set(replayKey, nowMs);
    while (seenProofs.size > MAX_REMEMBERED_PROOFS) {
      const oldest = seenProofs.keys().next().value;
      if (oldest === undefined) break;
      seenProofs.delete(oldest);
    }
    return null;
  };

  const authenticate = Effect.fn("personalSystemReboot.authenticate")(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const scheme =
      typeof authorization === "string"
        ? authorization.startsWith("Bearer ")
          ? "bearer"
          : authorization.startsWith("DPoP ")
            ? "dpop"
            : null
        : null;
    if (scheme === null || typeof authorization !== "string") {
      return { ok: false, status: 401, error: "Sign in on this phone first." } as AuthOutcome;
    }
    const token = authorization.slice(scheme === "bearer" ? 7 : 5).trim();
    if (token.length === 0) {
      return { ok: false, status: 401, error: "Sign in on this phone first." } as AuthOutcome;
    }
    const key = tokenKey(token);
    const sessions = yield* SessionStore.SessionStore;
    const verified = yield* sessions.verify(token).pipe(Effect.result);

    let sessionId: string;
    let thumbprint: string | undefined;
    let remembered = false;
    if (verified._tag === "Success") {
      const session = verified.success;
      if (session.subject === MCP_CLIENT_SUBJECT) {
        deps.log("refused an MCP client session");
        return { ok: false, status: 401, error: "Bots cannot restart the laptop." } as AuthOutcome;
      }
      if (session.method !== "bearer-access-token" && session.method !== "dpop-access-token") {
        return { ok: false, status: 401, error: "Use the hbots phone app." } as AuthOutcome;
      }
      if (!session.scopes.includes(AuthEnvironmentMaintainScope)) {
        return {
          ok: false,
          status: 403,
          error: "Only the owner's phone can restart the laptop.",
        } as AuthOutcome;
      }
      sessionId = session.sessionId;
      thumbprint = session.proofKeyThumbprint;
      const expiresAtMs = session.expiresAt?.epochMilliseconds ?? deps.nowMs() + 60 * 60_000;
      remember(key, { sessionId, expiresAtMs, proofKeyThumbprint: thumbprint });
    } else if (SessionStore.isSessionCredentialInvalidError(verified.failure)) {
      credentials.delete(key);
      return { ok: false, status: 401, error: "Sign in on this phone again." } as AuthOutcome;
    } else {
      // The store could not read the session (the database is failing). Only a
      // credential that passed here before, and has not expired, gets through.
      const known = credentials.get(key);
      if (known === undefined || known.expiresAtMs <= deps.nowMs()) {
        deps.log("session store unavailable and this credential is not remembered");
        return {
          ok: false,
          status: 503,
          error:
            "The server cannot check your sign-in because its database is not answering. Restart the laptop by hand.",
        } as AuthOutcome;
      }
      deps.log("session store unavailable; using the remembered owner credential");
      sessionId = known.sessionId;
      thumbprint = known.proofKeyThumbprint;
      remembered = true;
    }

    if (thumbprint !== undefined) {
      if (scheme !== "dpop") {
        return {
          ok: false,
          status: 401,
          error: "This sign-in needs a DPoP proof.",
        } as AuthOutcome;
      }
      const proofError = checkProof(request, token, thumbprint);
      if (proofError !== null) {
        return { ok: false, status: 401, error: proofError } as AuthOutcome;
      }
    } else if (scheme === "dpop" || request.headers.dpop !== undefined) {
      return {
        ok: false,
        status: 401,
        error: "DPoP needs a proof-bound sign-in.",
      } as AuthOutcome;
    }
    return { ok: true, sessionId, remembered } as AuthOutcome;
  });

  const executeLayeredReboot = async () => {
    const errors: string[] = [];

    // Tier 1: hbots-rebootd Unix socket
    if (deps.requestRebootDaemon !== undefined) {
      try {
        const res = await deps.requestRebootDaemon();
        if (res.ok) {
          deps.log("hbots-rebootd accepted the reboot");
          return;
        }
        const msg = `hbots-rebootd failed: ${res.error ?? `HTTP ${res.status ?? "error"}`}`;
        errors.push(msg);
        deps.log(`${msg}; falling back to direct D-Bus`);
      } catch (cause) {
        const msg = `hbots-rebootd failed: ${String(cause)}`;
        errors.push(msg);
        deps.log(`${msg}; falling back to direct D-Bus`);
      }
    }

    // Tier 2: pure-Node direct D-Bus over /run/dbus/system_bus_socket
    if (deps.dbusReboot !== undefined) {
      try {
        const res = await deps.dbusReboot();
        if (res.ok) {
          deps.log("logind accepted the reboot over D-Bus");
          return;
        }
        const msg = `D-Bus Reboot failed: ${res.error}`;
        errors.push(msg);
        deps.log(msg);
      } catch (cause) {
        const msg = `D-Bus Reboot failed: ${String(cause)}`;
        errors.push(msg);
        deps.log(msg);
      }
    }

    // Tier 3: busctl fallback
    if (deps.run !== undefined) {
      try {
        const result = await deps.run(REBOOT_ARGV);
        if (result.exitCode === 0) {
          deps.log("logind accepted the reboot");
          return;
        }
        const msg = `logind refused the reboot: ${commandFailureText(result)}`;
        errors.push(msg);
        deps.log(msg);
      } catch (cause) {
        const msg = `the reboot command failed: ${String(cause)}`;
        errors.push(msg);
        deps.log(msg);
      }
    }

    lastError =
      errors.length > 0 ? errors.join(" | ") : "No reboot transport succeeded on this laptop.";
    deps.log(`all reboot transports failed: ${lastError}`);
  };

  const status = HttpRouter.add(
    "GET",
    PERSONAL_SYSTEM_REBOOT_PATH,
    Effect.gen(function* () {
      const auth = yield* authenticate();
      if (!auth.ok) return yield* refuse(auth.status, auth.error);
      const preflight = yield* Effect.promise(() => layeredPreflight(deps));
      return yield* json(200, {
        ok: true,
        canReboot: preflight.ok,
        ...(preflight.ok ? { transport: preflight.transport } : { error: preflight.error }),
        dryRun: deps.dryRun(),
        lastError,
        ...(rescueConfig !== null ? { rescue: rescueConfig } : {}),
      });
    }),
  );

  const reboot = HttpRouter.add(
    "POST",
    PERSONAL_SYSTEM_REBOOT_PATH,
    Effect.gen(function* () {
      const auth = yield* authenticate();
      if (!auth.ok) return yield* refuse(auth.status, auth.error);
      const nowMs = deps.nowMs();
      if (lastAcceptedAtMs !== null && nowMs - lastAcceptedAtMs < REBOOT_RATE_LIMIT_MS) {
        const waitSeconds = Math.ceil((REBOOT_RATE_LIMIT_MS - (nowMs - lastAcceptedAtMs)) / 1_000);
        return yield* refuse(
          429,
          `A restart was already asked for. Try again in ${waitSeconds} s if the laptop did not restart.`,
        );
      }
      const preflight = yield* Effect.promise(() => layeredPreflight(deps));
      if (!preflight.ok) {
        lastError = preflight.error;
        deps.log(`preflight refused: ${preflight.error}`);
        return yield* refuse(409, preflight.error);
      }
      lastAcceptedAtMs = nowMs;
      lastError = null;
      const dryRun = deps.dryRun();
      deps.log(
        `accepted from session ${auth.sessionId}${auth.remembered ? " (remembered credential)" : ""} via ${preflight.transport}; ${dryRun ? "dry run" : "rebooting"} in ${REBOOT_DELAY_MS} ms`,
      );
      deps.schedule(() => {
        if (deps.dryRun()) {
          deps.log(`would reboot (${preflight.transport})`);
          return;
        }
        void executeLayeredReboot();
      }, REBOOT_DELAY_MS);
      return yield* json(202, {
        ok: true,
        dryRun,
        rebootInMs: REBOOT_DELAY_MS,
      });
    }),
  );

  return Layer.mergeAll(status, reboot);
};
