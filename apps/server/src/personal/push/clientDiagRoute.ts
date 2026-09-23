/**
 * `POST /api/personal/client-diag`: one line in the server log per
 * notification-tap step, sent by the service worker and the page
 * (public/sw.js, web features/personal/serviceWorker.ts). A tap that fails on
 * the phone leaves no other trace, so these lines say which delivery route was
 * taken, how many windows the worker saw and whether the page answered.
 *
 * Open to anonymous callers on purpose: the phone's service worker cannot
 * always present the page's credential (a relay session can live in the page
 * rather than in a cookie the worker's fetch carries), and a signed-in-only
 * route left us blind exactly where taps fail. It stays safe because nothing
 * the caller sends is stored or reflected as-is: the body is rebuilt from a
 * strict allowlist (known events, fixed enums, short tokens, same-origin
 * paths, numbers and booleans; every other field is dropped). It is JSON only
 * (a cross-site form cannot send it without a preflight), bodies are capped
 * at 4KB, and lines are rate limited globally and per client. Each line says
 * whether the caller was signed in. Refusals are logged as fixed words (and
 * rate limited), so a client that keeps failing is visible, not silent.
 */
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

export const PERSONAL_CLIENT_DIAG_PATH = "/api/personal/client-diag";
export const CLIENT_DIAG_MAX_BYTES = 4096;
/** Accepted lines per minute, all callers together. */
export const CLIENT_DIAG_MAX_PER_MINUTE = 60;
/** Accepted lines per minute from one client address. */
export const CLIENT_DIAG_MAX_PER_CLIENT_PER_MINUTE = 20;
/** Refusal lines per minute, so a looping or hostile caller cannot flood the log. */
export const CLIENT_DIAG_MAX_REFUSALS_LOGGED_PER_MINUTE = 10;
/** What reaches the log line, after re-serialisation. */
export const CLIENT_DIAG_LOGGED_CHARS = 1500;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const reply = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: HEADERS });

/** "signed-in", "no-scope" or "anonymous"; never fails the request. */
const authState = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.map((session) =>
      session.scopes.includes(AuthOrchestrationReadScope) ? "signed-in" : "no-scope",
    ),
    Effect.orElseSucceed(() => "anonymous"),
  );
});

export const CLIENT_DIAG_EVENTS: ReadonlySet<string> = new Set([
  "notificationclick",
  "notificationclick-start",
  "push-shown",
  "tap-received",
  "sw-message-received",
  "broadcast-received",
  "page-boot",
  // Real-user timings (web features/personal/perfRum.ts).
  "perf",
]);
const VISIBILITY = new Set(["visible", "hidden", "prerender", "unknown"]);
const TOKEN = /^[A-Za-z0-9._:-]+$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/;
const ERROR_TEXT = /^[A-Za-z0-9 ._:-]+$/;

type Read = (value: unknown) => unknown;

const token =
  (max: number): Read =>
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= max && TOKEN.test(value)
      ? value
      : undefined;
const path: Read = (value) =>
  typeof value === "string" && value.length <= 200 && PATH.test(value) && !value.startsWith("//")
    ? value
    : undefined;
const bool: Read = (value) => (typeof value === "boolean" ? value : undefined);
const count: Read = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e13
    ? value
    : undefined;
const visibility: Read = (value) =>
  typeof value === "string" && VISIBILITY.has(value) ? value : undefined;
const nullable =
  (read: Read): Read =>
  (value) =>
    value === null ? null : read(value);
const object =
  (fields: Record<string, Read>) =>
  (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, read] of Object.entries(fields)) {
      const field = read((value as Record<string, unknown>)[key]);
      if (field !== undefined) out[key] = field;
    }
    return out;
  };

const CLIENT = object({
  path: nullable(path),
  visibility: nullable(visibility),
  focused: nullable(bool),
});
const FIELDS: Record<string, Read> = {
  sw: token(32),
  id: nullable(token(64)),
  url: path,
  page: nullable(token(80)),
  type: token(32),
  via: token(32),
  route: token(32),
  focus: token(16),
  journey: token(16),
  watching: nullable(token(32)),
  visibility,
  error: (value) =>
    typeof value === "string" && value.length <= 80 && ERROR_TEXT.test(value) ? value : undefined,
  cache: bool,
  broadcast: bool,
  navigated: bool,
  controlled: bool,
  standalone: bool,
  warm: bool,
  snapshot: bool,
  ms: count,
  at: count,
  clients: (value) =>
    Array.isArray(value)
      ? value
          .slice(0, 5)
          .map(CLIENT)
          .filter((entry) => entry !== undefined)
      : undefined,
  ack: nullable(object({ via: token(32), visibility: nullable(visibility) })),
};

/**
 * The record rebuilt from the allowlist, or null when the body is not a JSON
 * object naming a known event. Nothing outside FIELDS survives.
 */
export function sanitizeClientDiag(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const input = parsed as Record<string, unknown>;
  if (typeof input.event !== "string" || !CLIENT_DIAG_EVENTS.has(input.event)) return null;
  const out: Record<string, unknown> = { event: input.event };
  for (const [key, read] of Object.entries(FIELDS)) {
    const value = read(input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The sanitized record as it will be logged, or null when it is refused. */
export function clientDiagLine(text: string, auth?: string): string | null {
  const record = sanitizeClientDiag(text);
  if (record === null) return null;
  const line = JSON.stringify(auth === undefined ? record : { ...record, auth });
  return line.length > CLIENT_DIAG_LOGGED_CHARS
    ? `${line.slice(0, CLIENT_DIAG_LOGGED_CHARS)}...`
    : line;
}

/**
 * Who is asking, for the per-client limit. Behind T3 Connect every request
 * arrives from the local tunnel process, so Cloudflare's client address is
 * used when present; otherwise the socket address.
 */
function clientKey(request: HttpServerRequest.HttpServerRequest): string {
  const forwarded = request.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.slice(0, 64);
  return Option.getOrElse(request.remoteAddress, () => "unknown");
}

export interface ClientDiagRouteOptions {
  /** Where accepted lines go; the server log by default. */
  readonly record?: (line: string) => Effect.Effect<void>;
}

export const makePersonalClientDiagRouteLayer = (options: ClientDiagRouteOptions = {}) => {
  const record = options.record ?? ((line: string) => Effect.logInfo(`client-diag ${line}`));
  let windowStart = 0;
  let windowCount = 0;
  let refusalsLogged = 0;
  const perClient = new Map<string, number>();

  return HttpRouter.add(
    "POST",
    PERSONAL_CLIENT_DIAG_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const now = yield* Clock.currentTimeMillis;
      if (now - windowStart >= 60_000) {
        windowStart = now;
        windowCount = 0;
        refusalsLogged = 0;
        perClient.clear();
      }
      const auth = yield* authState;
      const refuse = (status: number, body: string, reason: string) =>
        Effect.gen(function* () {
          if (refusalsLogged < CLIENT_DIAG_MAX_REFUSALS_LOGGED_PER_MINUTE) {
            refusalsLogged += 1;
            // Fixed words only: nothing the caller sent reaches this line.
            // @effect-diagnostics-next-line preferSchemaOverJson:off - a log line built from literals.
            yield* record(JSON.stringify({ event: "refused", reason, status, auth }));
          }
          return reply(status, body);
        });

      const contentType = request.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(contentType)) {
        return yield* refuse(415, "Unsupported Media Type", "content-type");
      }
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > CLIENT_DIAG_MAX_BYTES) {
        return yield* refuse(413, "Payload Too Large", "too-large");
      }
      const client = clientKey(request);
      const fromClient = perClient.get(client) ?? 0;
      if (
        windowCount >= CLIENT_DIAG_MAX_PER_MINUTE ||
        fromClient >= CLIENT_DIAG_MAX_PER_CLIENT_PER_MINUTE
      ) {
        return yield* refuse(429, "Too Many Requests", "rate-limit");
      }
      windowCount += 1;
      perClient.set(client, fromClient + 1);

      let received = 0;
      const collected = yield* collectUint8StreamText({
        stream: request.stream.pipe(
          Stream.takeUntil((chunk) => {
            received += chunk.byteLength;
            return received > CLIENT_DIAG_MAX_BYTES;
          }),
        ),
        maxBytes: CLIENT_DIAG_MAX_BYTES + 1,
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      );
      if (collected === null) return yield* refuse(400, "Bad Request", "unreadable");
      if (collected.bytes > CLIENT_DIAG_MAX_BYTES) {
        return yield* refuse(413, "Payload Too Large", "too-large");
      }
      const line = clientDiagLine(collected.text, auth);
      if (line === null) return yield* refuse(400, "Bad Request", "not-allowlisted");
      yield* record(line);
      return HttpServerResponse.empty({ status: 204, headers: HEADERS });
    }),
  );
};

export const personalClientDiagRouteLayer = makePersonalClientDiagRouteLayer();
