// @effect-diagnostics nodeBuiltinImport:off - the reboot runs busctl with a fixed argv through execFile (no shell), and the in-memory credential cache keys on a sha256 of the token.
/**
 * `/api/personal/system/reboot`: the owner restarts the laptop from the phone.
 *
 * This is the way out when SQLite or the disk has failed (1.67.50: an
 * SQLITE_IOERR turned the drive read-only and no bot could be reached), so the
 * whole path stays free of DB and file writes:
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
 *   GETs this path whenever Settings opens, which is what warms the memory.
 * - Logs go to stdout only (`console`), the rate limit and the last failure live
 *   in memory, and the reboot itself is `busctl` with a fixed argv.
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

import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as SessionStore from "../../auth/SessionStore.ts";
import { requestUrl } from "../../requestUrl.ts";

export const PERSONAL_SYSTEM_REBOOT_PATH = "/api/personal/system/reboot";
/** The reply goes out first; logind is asked this long after. */
export const REBOOT_DELAY_MS = 1_000;
/** One accepted restart per this window, in memory. */
export const REBOOT_RATE_LIMIT_MS = 60_000;
export const REBOOT_DRY_RUN_ENV = "HBOTS_REBOOT_DRY_RUN";
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

export interface RebootRouteDeps {
  readonly run: RebootCommandRunner;
  readonly dryRun: () => boolean;
  readonly nowMs: () => number;
  readonly schedule: (task: () => void, delayMs: number) => void;
  readonly log: (line: string) => void;
}

export const liveRebootRouteDeps: RebootRouteDeps = {
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
  | { readonly ok: true; readonly canReboot: string }
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
  return { ok: true, canReboot: answer };
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
 * failure) belongs to the returned layer, so each test gets its own.
 */
export const makePersonalSystemRebootRouteLayer = (deps: RebootRouteDeps = liveRebootRouteDeps) => {
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

  const status = HttpRouter.add(
    "GET",
    PERSONAL_SYSTEM_REBOOT_PATH,
    Effect.gen(function* () {
      const auth = yield* authenticate();
      if (!auth.ok) return yield* refuse(auth.status, auth.error);
      const preflight = yield* Effect.promise(() => rebootPreflight(deps.run));
      return yield* json(200, {
        ok: true,
        canReboot: preflight.ok,
        ...(preflight.ok ? {} : { error: preflight.error }),
        dryRun: deps.dryRun(),
        lastError,
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
      const preflight = yield* Effect.promise(() => rebootPreflight(deps.run));
      if (!preflight.ok) {
        lastError = preflight.error;
        deps.log(`preflight refused: ${preflight.error}`);
        return yield* refuse(409, preflight.error);
      }
      lastAcceptedAtMs = nowMs;
      lastError = null;
      const dryRun = deps.dryRun();
      deps.log(
        `accepted from session ${auth.sessionId}${auth.remembered ? " (remembered credential)" : ""}; ${dryRun ? "dry run" : "rebooting"} in ${REBOOT_DELAY_MS} ms`,
      );
      deps.schedule(() => {
        if (deps.dryRun()) {
          deps.log(`would reboot: ${REBOOT_ARGV.join(" ")}`);
          return;
        }
        void deps.run(REBOOT_ARGV).then(
          (result) => {
            if (result.exitCode === 0) {
              deps.log("logind accepted the reboot");
              return;
            }
            lastError = `logind refused the reboot: ${commandFailureText(result)}`;
            deps.log(lastError);
          },
          (cause: unknown) => {
            lastError = `the reboot command failed: ${String(cause)}`;
            deps.log(lastError);
          },
        );
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
