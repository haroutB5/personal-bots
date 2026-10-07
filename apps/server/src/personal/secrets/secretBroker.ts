// @effect-diagnostics nodeBuiltinImport:off - a socket-level call: the address checked is the address connected to.
// @effect-diagnostics globalTimers:off
/**
 * The secret broker: one HTTPS request made on a bot's behalf, with a saved
 * key's value put in by the server.
 *
 * A brokered key never leaves the server. The bot writes `{{secret:NAME}}`
 * where the value belongs and this module checks, then sends:
 *
 * - every key used must be brokered and bound to the origin being called;
 * - the placeholder may only be in the `Authorization` header (or the one
 *   header name the owner set for that key, e.g. `x-api-key`); the URL path,
 *   query and body only if the owner opted in for that key, and the key's path
 *   prefix and method list, when set, hold on every hop;
 * - the call must use at least one key (this is not a general fetch tool);
 * - HTTPS only, no login in the address, no IP address, no private, loopback,
 *   link-local or otherwise internal destination: checked on the address the
 *   socket actually connects to, so a name that resolves inward is refused;
 * - redirects are followed only within the same origin, at most three, and
 *   any other origin is refused (nothing carrying the key is sent there);
 * - the response is cut at a size cap and every known secret value is masked
 *   in it, so an API that echoes the key back cannot hand it to the bot;
 * - the value is never returned, logged or put in an error.
 *
 * Kept free of Effect: the tool handler wraps `call` and the tests inject the
 * resolver, the address rule and TLS options.
 */
import * as NodeDns from "node:dns";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

import {
  normalizePersonalSecretOrigin,
  PERSONAL_SECRET_FORBIDDEN_HEADERS,
  type PersonalSecretPlacement,
} from "@t3tools/contracts";
import * as Context from "effect/Context";

import { makeSecretRedactor, secretRedactor, type SecretRedactor } from "./secretRedaction.ts";

/** Hard ceiling for what a caller can ask for. */
export const BROKER_MAX_RESPONSE_BYTES = 1_000_000;
export const BROKER_DEFAULT_RESPONSE_BYTES = 262_144;
export const BROKER_MAX_REQUEST_BODY_BYTES = 262_144;
export const BROKER_DEFAULT_TIMEOUT_MS = 30_000;
export const BROKER_MAX_TIMEOUT_MS = 60_000;
export const BROKER_MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 4096;
const MAX_HEADERS = 24;
const MAX_HEADER_VALUE = 4096;

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type BrokerMethod = (typeof METHODS)[number];

/** Headers a bot may not set: the transport owns them. */
const FORBIDDEN_REQUEST_HEADERS = PERSONAL_SECRET_FORBIDDEN_HEADERS;

/** Response headers worth showing; set-cookie and the rest stay on the server. */
const SHOWN_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "date",
  "etag",
  "last-modified",
  "retry-after",
  "link",
  "x-request-id",
  "request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
]);

/** A refusal or failure worded for the bot. Never carries a value. */
export class SecretBrokerError extends Error {
  readonly _tag = "SecretBrokerError";
  constructor(message: string) {
    super(message);
    this.name = "SecretBrokerError";
  }
}

export interface BrokerSecret {
  readonly name: string;
  readonly mode: "brokered" | "env";
  readonly origins: ReadonlyArray<string>;
  /** Where the placeholder may go; absent or `{}` = the Authorization header only. */
  readonly placement?: PersonalSecretPlacement | undefined;
  readonly value: string;
}

export interface BrokerRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** `Authorization: Basic base64(username:value)`, built here so the bot never needs the value. */
  readonly basicAuth?: { readonly username: string; readonly secret: string } | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export interface BrokerResult {
  readonly status: number;
  readonly statusText: string;
  /** Just the origin that answered: the full address can carry a key in its query. */
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Text, with every known secret value masked; null for a body that is not text. */
  readonly body: string | null;
  readonly bodyBytes: number;
  readonly truncated: boolean;
  readonly redirects: number;
  readonly secretsUsed: ReadonlyArray<string>;
  readonly ms: number;
}

export interface BrokerDeps {
  /** Resolves a host to every address it has. Defaults to the OS resolver. */
  readonly resolve?: (
    hostname: string,
  ) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;
  /** Whether a destination address may be connected to. Defaults to {@link isPublicAddress}. */
  readonly isAddressAllowed?: (address: string) => boolean;
  /** Extra `https.request` options (tests: a private CA). */
  readonly requestOptions?: NodeHttps.RequestOptions;
  readonly redactor?: SecretRedactor;
  readonly now?: () => number;
}

/** Optional test hooks for the tool handler: a resolver, an address rule, a private CA. */
export class SecretBrokerConfig extends Context.Service<SecretBrokerConfig, BrokerDeps>()(
  "t3/personal/secrets/secretBroker/SecretBrokerConfig",
) {}

/** Kill switch: `PERSONAL_SECRET_BROKER=off` refuses every call (also 0 / false / no). */
export const secretBrokerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = (env.PERSONAL_SECRET_BROKER ?? env.T3CODE_PERSONAL_SECRET_BROKER)
    ?.trim()
    .toLowerCase();
  return raw === undefined || !["off", "0", "false", "no"].includes(raw);
};

const PLACEHOLDER = /\{\{\s*secret:([A-Z][A-Z0-9_]{0,63})\s*(?:\|\s*(base64))?\s*\}\}/g;

/** The key names written as placeholders anywhere in `text`. */
export const placeholderNames = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Every range a public API never lives in. IPv6 transition forms are refused wholesale. */
const blocked = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  // IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo: a way to name an IPv4 destination.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** True for an address on the public internet: not private, loopback, link-local, multicast or reserved. */
export const isPublicAddress = (address: string): boolean => {
  const clean = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = NodeNet.isIP(clean);
  if (family === 0) return false;
  if (family === 6 && inIpv4Space(clean)) return false;
  return !blocked.check(clean, family === 4 ? "ipv4" : "ipv6");
};

/**
 * IPv6 addresses that stand for an IPv4 one or for "nothing": `::`, `::1`, the
 * IPv4-compatible `::a.b.c.d` and the IPv4-mapped `::ffff:a.b.c.d`. Node's
 * block list would match a plain IPv4 address against the mapped range, so
 * these are checked on the expanded address instead.
 */
const inIpv4Space = (address: string): boolean => {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const parts = dotted[1]!.split(".").map(Number);
    text = `${text.slice(0, dotted.index)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head = "", tail = ""] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const hextets = text.includes("::")
    ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  if (hextets.length !== 8) return true;
  const value = hextets.map((part) => Number.parseInt(part, 16));
  const zeros = value.slice(0, 5).every((part) => part === 0);
  return zeros && (value[5] === 0 || value[5] === 0xffff);
};

// ---------------------------------------------------------------------------
// Building the request
// ---------------------------------------------------------------------------

interface Prepared {
  readonly method: BrokerMethod;
  readonly url: URL;
  readonly origin: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer | undefined;
  readonly secretsUsed: ReadonlyArray<string>;
  readonly values: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Per key, the path prefix and methods that must hold on every hop (redirects included). */
  readonly limits: ReadonlyArray<KeyLimits>;
}

interface KeyLimits {
  readonly name: string;
  readonly pathPrefix: string | undefined;
  readonly methods: ReadonlyArray<string> | undefined;
}

/** True when `pathname` is the prefix or under it, on a path-segment boundary. */
const pathWithin = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The refusal for a key used outside its path prefix or method list, or null when it holds. */
const limitRefusal = (
  limits: ReadonlyArray<KeyLimits>,
  pathname: string,
  method: string,
): string | null => {
  for (const limit of limits) {
    if (limit.methods !== undefined && !limit.methods.includes(method)) {
      return `${limit.name} may only be used with ${limit.methods.join(", ")}, not ${method}.`;
    }
    if (limit.pathPrefix !== undefined && !pathWithin(pathname, limit.pathPrefix)) {
      return `${limit.name} may only be sent to paths under ${limit.pathPrefix}.`;
    }
  }
  return null;
};

const refuse = (message: string): never => {
  throw new SecretBrokerError(message);
};

/** The authority part of an address (`host[:port]`), found without parsing placeholders as a host. */
const authorityOf = (url: string): string => {
  const afterScheme = url.replace(/^https:\/\//i, "");
  const end = afterScheme.search(/[/?#]/);
  return end === -1 ? afterScheme : afterScheme.slice(0, end);
};

/** Checks the request and puts the key values in. Throws `SecretBrokerError` with a bot-readable reason. */
export const prepareBrokerRequest = (
  request: BrokerRequest,
  secrets: ReadonlyArray<BrokerSecret>,
): Prepared => {
  const method = request.method.toUpperCase() as BrokerMethod;
  if (!METHODS.includes(method)) {
    refuse(`Method ${request.method} is not allowed. Use ${METHODS.join(", ")}.`);
  }
  const rawUrl = request.url.trim();
  if (rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    refuse("The url is empty or too long.");
  }
  if (!/^https:\/\//i.test(rawUrl)) {
    refuse("Only https:// addresses are allowed.");
  }
  const authority = authorityOf(rawUrl);
  if (authority.includes("{{")) {
    refuse(
      "A key placeholder cannot be in the host. Put it in a header, the path, the query or the body.",
    );
  }
  if (authority.includes("@")) {
    refuse(
      "A login in the address is not allowed. Use an Authorization header with a key placeholder.",
    );
  }

  const headerEntries = Object.entries(request.headers ?? {});
  if (headerEntries.length > MAX_HEADERS) refuse(`At most ${MAX_HEADERS} headers.`);
  for (const [name, value] of headerEntries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) refuse(`Header name '${name}' is not valid.`);
    if (name.includes("{{")) refuse("A key placeholder cannot be in a header name.");
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      refuse(`The ${name} header is set by the server; leave it out.`);
    }
    if (value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value.replace(PLACEHOLDER, ""))) {
      refuse(`Header ${name} has a value that is too long or has a line break.`);
    }
  }
  if (request.body !== undefined && (method === "GET" || method === "HEAD")) {
    refuse(`A ${method} request has no body.`);
  }
  if (
    request.body !== undefined &&
    Buffer.byteLength(request.body, "utf8") > BROKER_MAX_REQUEST_BODY_BYTES
  ) {
    refuse(`The body is over ${BROKER_MAX_REQUEST_BODY_BYTES} bytes.`);
  }

  // The origin being called, from the address with placeholders blanked.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.replace(PLACEHOLDER, "x"));
  } catch {
    return refuse("The url is not a valid address.");
  }
  const origin = normalizePersonalSecretOrigin(parsed.origin);
  if (origin === null || origin !== parsed.origin) {
    return refuse(
      "That host is not allowed: it must be a public HTTPS site name (no IP address, no localhost or internal name).",
    );
  }

  const used = new Set<string>([
    ...placeholderNames(rawUrl),
    ...headerEntries.flatMap(([, value]) => placeholderNames(value)),
    ...placeholderNames(request.body ?? ""),
  ]);
  if (request.basicAuth !== undefined) used.add(request.basicAuth.secret);
  if (used.size === 0) {
    refuse(
      "This tool only sends requests that use a saved key. Write {{secret:NAME}} where the key's value goes, or pass basicAuth. For anything else use the browser or read_pages.",
    );
  }

  const byName = new Map(secrets.map((secret) => [secret.name, secret]));
  const values: Array<{ name: string; value: string }> = [];
  for (const name of used) {
    const secret = byName.get(name);
    if (secret === undefined) {
      refuse(`No saved key named ${name}. Ask for it with request_secret.`);
    } else if (secret.mode !== "brokered") {
      refuse(
        `${name} is saved as an environment variable, not as a brokered key, so it cannot be used here. Ask the user to switch it to Brokered in Settings > API keys.`,
      );
    } else if (!secret.origins.includes(origin)) {
      refuse(
        `${name} is not allowed to be sent to ${origin}. It is bound to: ${secret.origins.join(", ") || "no origin"}. Ask the user to add this origin in Settings > API keys.`,
      );
    } else {
      values.push({ name, value: secret.value });
    }
  }

  // Where each key's placeholder sits, against what its owner allowed.
  const inUrl = new Set(placeholderNames(rawUrl));
  const inBody = new Set(placeholderNames(request.body ?? ""));
  const inHeaders = new Map<string, Set<string>>();
  for (const [headerName, value] of headerEntries) {
    for (const name of placeholderNames(value)) {
      const lower = headerName.toLowerCase();
      inHeaders.set(lower, new Set([...(inHeaders.get(lower) ?? []), name]));
    }
  }
  if (request.basicAuth !== undefined) {
    inHeaders.set(
      "authorization",
      new Set([...(inHeaders.get("authorization") ?? []), request.basicAuth.secret]),
    );
  }
  for (const name of used) {
    const placement = byName.get(name)!.placement ?? {};
    const allowedHeader = placement.header;
    const headerHint =
      allowedHeader === undefined
        ? "the Authorization header"
        : `the Authorization or ${allowedHeader} header`;
    if ((inUrl.has(name) || inBody.has(name)) && placement.anywhere !== true) {
      refuse(
        `${name} may only be sent in ${headerHint}, not in the URL or the body. If this API needs it elsewhere, ask the user to allow that for this key in Settings > API keys.`,
      );
    }
    for (const [headerName, names] of inHeaders) {
      if (!names.has(name)) continue;
      if (headerName !== "authorization" && headerName !== allowedHeader) {
        refuse(
          `${name} may only be sent in ${headerHint}, not in the ${headerName} header. If this API wants another header, ask the user to set it for this key in Settings > API keys.`,
        );
      }
    }
  }
  const limits: ReadonlyArray<KeyLimits> = [...used].map((name) => {
    const placement = byName.get(name)!.placement ?? {};
    return { name, pathPrefix: placement.pathPrefix, methods: placement.methods };
  });

  const substitute = (text: string, encode: (value: string) => string): string =>
    text.replace(PLACEHOLDER, (_match, name: string, transform: string | undefined) => {
      const value = byName.get(name)!.value;
      return encode(transform === "base64" ? Buffer.from(value, "utf8").toString("base64") : value);
    });

  const url = new URL(substitute(rawUrl, encodeURIComponent));
  if (url.origin !== origin) refuse("The address changed once the key was added; refused.");
  const outsideLimit = limitRefusal(limits, url.pathname, method);
  if (outsideLimit !== null) refuse(outsideLimit);

  const headers: Record<string, string> = {};
  for (const [name, value] of headerEntries) {
    headers[name] = substitute(value, (text) => text);
    if (/[\r\n\0]/.test(headers[name]!))
      refuse(`Header ${name} would have a line break once the key is added.`);
  }
  if (request.basicAuth !== undefined) {
    const user = request.basicAuth.username;
    if (/[\r\n\0:]/.test(user)) refuse("The basicAuth username cannot have a colon or line break.");
    const secret = byName.get(request.basicAuth.secret)!;
    headers.Authorization = `Basic ${Buffer.from(`${user}:${secret.value}`, "utf8").toString("base64")}`;
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")) {
    headers["User-Agent"] = "personal-bots-secret-broker";
  }
  headers["Accept-Encoding"] = "identity";

  const body =
    request.body === undefined
      ? undefined
      : Buffer.from(
          substitute(request.body, (text) => text),
          "utf8",
        );
  if (body !== undefined && body.length > BROKER_MAX_REQUEST_BODY_BYTES) {
    refuse(`The body is over ${BROKER_MAX_REQUEST_BODY_BYTES} bytes once the key is added.`);
  }

  return { method, url, origin, headers, body, secretsUsed: [...used], values, limits };
};

// ---------------------------------------------------------------------------
// Sending it
// ---------------------------------------------------------------------------

interface RawResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly body: Buffer;
  readonly truncated: boolean;
}

const defaultResolve: NonNullable<BrokerDeps["resolve"]> = (hostname) =>
  NodeDns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A DNS lookup the socket itself uses, so the address checked is the address
 * connected to (a name that changes its answer between a check and a connect
 * gets nothing). Every address a name has must be public: a mixed answer is refused.
 */
const guardedLookup =
  (deps: BrokerDeps) =>
  (
    hostname: string,
    options: NodeDns.LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | NodeDns.LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    const allowed = deps.isAddressAllowed ?? isPublicAddress;
    (deps.resolve ?? defaultResolve)(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((entry) => !allowed(entry.address))) {
          const error: NodeJS.ErrnoException = new SecretBrokerError(
            "That host resolves to a private, loopback or otherwise internal address; refused.",
          );
          error.code = "ESECRETBROKER";
          callback(error, "");
          return;
        }
        if (options.all === true) {
          callback(
            null,
            addresses.map((entry) => ({ address: entry.address, family: entry.family })),
          );
          return;
        }
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };

const requestOnce = (
  deps: BrokerDeps,
  target: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const outgoing = { ...headers };
    if (body !== undefined) outgoing["Content-Length"] = String(body.length);
    const request = NodeHttps.request(
      {
        ...deps.requestOptions,
        protocol: "https:",
        hostname: target.hostname,
        port: target.port === "" ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method,
        headers: outgoing,
        servername: target.hostname,
        lookup: guardedLookup(deps) as NodeHttps.RequestOptions["lookup"],
        agent: false,
        signal,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, Math.max(0, room)));
            size = maxBytes;
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        const finish = () =>
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: response.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
        response.on("end", finish);
        response.on("close", () => {
          if (truncated) finish();
        });
        response.on("error", (error) => {
          if (truncated) finish();
          else reject(error);
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });

const describeNetworkError = (error: unknown): string => {
  if (error instanceof SecretBrokerError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ESECRETBROKER") {
    return "That host resolves to a private, loopback or otherwise internal address; refused.";
  }
  if ((error as Error | undefined)?.name === "AbortError" || code === "ABORT_ERR") {
    return "The request timed out.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "The host could not be found.";
  if (code === "ECONNREFUSED") return "The host refused the connection.";
  if (code === "ECONNRESET") return "The connection was reset.";
  if (code === "ETIMEDOUT") return "The connection timed out.";
  if (
    code !== undefined &&
    /CERT|TLS|SSL|DEPTH_ZERO|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/i.test(code)
  ) {
    return `The server's certificate was not accepted (${code}).`;
  }
  // Never the raw message: a library error can echo the request.
  return "The request failed before a response arrived.";
};

const textOf = (body: Buffer, contentType: string | undefined): string | null => {
  if (body.length === 0) return "";
  if (contentType !== undefined && /^(image|audio|video)\//i.test(contentType)) return null;
  if (contentType !== undefined && /application\/(zip|gzip|pdf|octet-stream)/i.test(contentType)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // A response cut in the middle of a character is still text.
    try {
      const trimmed = body.subarray(0, Math.max(0, body.length - 3));
      return new TextDecoder("utf-8", { fatal: true }).decode(trimmed);
    } catch {
      return null;
    }
  }
};

/** Sends one request with its keys put in. Throws `SecretBrokerError` for a refusal or a failure. */
export const callWithSecrets = async (
  request: BrokerRequest,
  secrets: ReadonlyArray<BrokerSecret>,
  deps: BrokerDeps = {},
  signal?: AbortSignal,
): Promise<BrokerResult> => {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const redactor = deps.redactor ?? secretRedactor;
  const prepared = prepareBrokerRequest(request, secrets);
  const timeoutMs = Math.min(
    Math.max(request.timeoutMs ?? BROKER_DEFAULT_TIMEOUT_MS, 1_000),
    BROKER_MAX_TIMEOUT_MS,
  );
  const maxBytes = Math.min(
    Math.max(request.maxResponseBytes ?? BROKER_DEFAULT_RESPONSE_BYTES, 1_024),
    BROKER_MAX_RESPONSE_BYTES,
  );

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

  let target = prepared.url;
  let method: string = prepared.method;
  let body = prepared.body;
  let redirects = 0;
  let response: RawResponse;
  for (;;) {
    try {
      response = await requestOnce(
        deps,
        target,
        method,
        prepared.headers,
        body,
        maxBytes,
        combined,
      );
    } catch (error) {
      throw new SecretBrokerError(describeNetworkError(error));
    }
    const location = response.headers.location;
    if (![301, 302, 303, 307, 308].includes(response.status) || typeof location !== "string") break;
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new SecretBrokerError("The server redirected to an address that is not valid.");
    }
    if (next.origin !== prepared.origin) {
      throw new SecretBrokerError(
        `The server redirected to ${next.origin}, a different origin. Nothing was sent there.`,
      );
    }
    redirects += 1;
    if (redirects > BROKER_MAX_REDIRECTS) {
      throw new SecretBrokerError(`More than ${BROKER_MAX_REDIRECTS} redirects.`);
    }
    target = next;
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = method === "HEAD" ? "HEAD" : "GET";
      body = undefined;
    }
    // The key's headers go along on a same-origin redirect, so its path prefix
    // and method list have to hold for the place it was sent to as well.
    const hopRefusal = limitRefusal(prepared.limits, target.pathname, method);
    if (hopRefusal !== null) {
      throw new SecretBrokerError(
        `The server redirected somewhere this key may not go. ${hopRefusal}`,
      );
    }
  }

  const contentType = (
    Array.isArray(response.headers["content-type"])
      ? response.headers["content-type"][0]
      : response.headers["content-type"]
  ) as string | undefined;
  const text = textOf(response.body, contentType);
  // Mask what the server knows, plus the values this call used (a key saved a
  // moment ago), in every spelling the redactor knows.
  const callRedactor = makeSecretRedactor({ enabled: () => true });
  callRedactor.replaceAll(prepared.values.map((entry, index) => ({ ...entry, id: String(index) })));
  const mask = (value: string) => callRedactor.redactText(redactor.redactText(value));
  // A response cut at the size cap can end in the middle of a key, which no
  // spelling matches any more: drop any tail that could still grow into one
  // (the same hold-back the chat stream uses) before masking what is left.
  const cutAtCap = (value: string) => callRedactor.stream().push(redactor.stream().push(value));
  const shown: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (!SHOWN_RESPONSE_HEADERS.has(lower)) continue;
    shown[lower] = mask(Array.isArray(value) ? value.join(", ") : value);
  }
  return {
    status: response.status,
    statusText: mask(response.statusText),
    origin: prepared.origin,
    headers: shown,
    body: text === null ? null : mask(response.truncated ? cutAtCap(text) : text),
    bodyBytes: response.body.length,
    truncated: response.truncated,
    redirects,
    secretsUsed: prepared.secretsUsed,
    ms: now() - startedAt,
  };
};
