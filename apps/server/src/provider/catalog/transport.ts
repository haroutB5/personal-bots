/**
 * HTTPS-only fetching for the catalogue and the installer.
 *
 * Every hop of every redirect is checked: a URL that is not HTTPS, carries a
 * user name or password, or names a loopback or private address is refused
 * before a byte is sent. The client is asked not to follow redirects itself
 * (`RequestInit.redirect = "manual"`), so a registry entry cannot bounce a
 * download through plain HTTP.
 *
 * Nothing here logs or returns a URL. Errors name the host only.
 *
 * @module provider/catalog/transport
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { HttpClientResponse } from "effect/unstable/http";

import { installError, isCatalogInstallError, type CatalogInstallError } from "./errors.ts";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface TransportOptions {
  /**
   * Tests talk to a server on 127.0.0.1. Production never sets this, and with
   * it set only loopback may use plain HTTP.
   */
  readonly allowLoopbackHttp?: boolean;
  readonly maxRedirects?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for a hostname that points at this machine or a private network. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local"))
    return true;
  if (host.startsWith("[")) return true; // IPv6 literals are never a registry host
  const parts = host.split(".").map(Number);
  if (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = parts as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

export interface CheckedUrl {
  readonly url: URL;
  readonly host: string;
}

/** Parses and vets one URL. Null when it may not be fetched. */
export function checkUrl(raw: string, options: TransportOptions = {}): CheckedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const loopback =
    options.allowLoopbackHttp === true && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (loopback) {
    return url.protocol === "http:" || url.protocol === "https:" ? { url, host: url.host } : null;
  }
  if (url.protocol !== "https:" || isPrivateHost(url.hostname)) return null;
  return { url, host: url.host };
}

export type FetchMethod = "GET" | "HEAD";

export interface TransportRequest {
  readonly url: string;
  readonly method?: FetchMethod;
  readonly headers?: Readonly<Record<string, string>>;
}

const resolveLocation = (location: string, base: URL): string | null => {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
};

const hostExtra = (raw: string): { readonly host?: string } => {
  const host = hostLabel(raw);
  return host === undefined ? {} : { host };
};

const hostLabel = (raw: string): string | undefined => {
  try {
    return new URL(raw).host || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Sends one request and follows up to five redirects by hand. Resolves with
 * the first non-redirect response whose status is below 400; anything else is
 * a `network` failure that names the host.
 */
export const openHttps = Effect.fn("CatalogTransport.openHttps")(function* (
  http: HttpClient.HttpClient,
  request: TransportRequest,
  options: TransportOptions = {},
) {
  const method = request.method ?? "GET";
  let current = request.url;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = checkUrl(current, options);
    if (checked === null) {
      return yield* installError(
        "network",
        hop === 0
          ? "hbots only downloads over HTTPS from public addresses."
          : "A download tried to redirect somewhere hbots does not allow.",
        hostExtra(current),
      );
    }
    const clientRequest = HttpClientRequest.make(method)(checked.url.toString()).pipe(
      HttpClientRequest.setHeaders(request.headers ?? {}),
    );
    const response: HttpClientResponse.HttpClientResponse = yield* http.execute(clientRequest).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError((cause) =>
        installError("network", `Could not reach ${checked.host}.`, {
          host: checked.host,
          cause,
        }),
      ),
    );
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers["location"];
      if (location === undefined || location === "") {
        return yield* installError("network", `${checked.host} sent a redirect with no address.`, {
          host: checked.host,
        });
      }
      const next = resolveLocation(location, checked.url);
      if (next === null) {
        return yield* installError("network", `${checked.host} sent a bad redirect.`, {
          host: checked.host,
        });
      }
      current = next;
      continue;
    }
    if (response.status >= 400) {
      return yield* installError("network", `${checked.host} answered ${response.status}.`, {
        host: checked.host,
      });
    }
    return { response, host: checked.host };
  }
  return yield* installError(
    "network",
    "The download was redirected too many times.",
    hostExtra(current),
  );
});

/** Reads at most `maxBytes` of a response body. A longer body fails instead of filling memory. */
export const readBounded = (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
  host: string,
): Effect.Effect<Uint8Array, CatalogInstallError> =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let total = 0;
    yield* response.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            return Effect.fail(
              installError("network", `${host} sent more data than expected.`, { host }),
            );
          }
          chunks.push(chunk);
          return Effect.void;
        }),
      ),
      Effect.mapError((cause) =>
        isCatalogInstallError(cause)
          ? cause
          : installError("network", `The connection to ${host} was interrupted.`, { host, cause }),
      ),
    );
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  });

/** GET a small text document (registry, overlay, icon) with a size cap. */
export const fetchText = Effect.fn("CatalogTransport.fetchText")(function* (
  http: HttpClient.HttpClient,
  url: string,
  maxBytes: number,
  options: TransportOptions = {},
) {
  const { response, host } = yield* openHttps(http, { url }, options);
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return yield* installError("network", `${host} sent more data than expected.`, { host });
  }
  const body = yield* readBounded(response, maxBytes, host);
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
});

/**
 * Size in bytes from a HEAD request, or null when the server does not say.
 * An encoded body (gzip) is null: its length is not the file's.
 */
export const headSize = Effect.fn("CatalogTransport.headSize")(function* (
  http: HttpClient.HttpClient,
  url: string,
  options: TransportOptions = {},
) {
  const { response } = yield* openHttps(http, { url, method: "HEAD" }, options);
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") return null;
  const length = Number(response.headers["content-length"]);
  return Number.isSafeInteger(length) && length > 0 ? length : null;
});
