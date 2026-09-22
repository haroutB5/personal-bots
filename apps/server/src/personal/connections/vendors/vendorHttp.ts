// @effect-diagnostics preferSchemaOverJson:off - a vendor reply is arbitrary JSON of an unknown shape; each adapter narrows what it reads.
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { ConnectionVendorError } from "../adapters.ts";

/**
 * The one way an adapter reaches a vendor.
 *
 * It exists as an injected function rather than a direct `fetch` so a test can
 * stand in for a provider without a network, and so the credential has exactly
 * one place it is allowed to go: the `authorization` header of a request built
 * here. The token is passed as `Redacted` right up to the header value, so an
 * accidental interpolation of the request object elsewhere cannot print it.
 */

export interface VendorHttpRequest {
  readonly operationId: string;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  /** A token vendor. Exactly one of `bearer` and `basic` belongs on a request. */
  readonly bearer?: Redacted.Redacted<string>;
  /**
   * An account-and-key vendor (Upstash's management API is one).
   *
   * The two halves stay separate until the header is built below: joining
   * them into `user:key` anywhere else would create a plaintext rendering of
   * the pair that nothing downstream knows to redact.
   */
  readonly basic?: {
    readonly username: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
  };
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface VendorHttpResponse {
  readonly status: number;
  /** Parsed JSON, or the raw text when the vendor did not send JSON. */
  readonly body: unknown;
  /** Lower-cased names. GitHub reports a classic token's scopes in a header. */
  readonly headers: Readonly<Record<string, string>>;
}

export type VendorHttp = (
  request: VendorHttpRequest,
) => Effect.Effect<VendorHttpResponse, ConnectionVendorError>;

/**
 * 401 and 403 are the owner's problem, not the bot's: the token has to be
 * replaced. Only for the identity reads a connection is validated with, where
 * the token is the one thing a 403 can be about.
 */
export const isUnauthorizedStatus = (status: number) => status === 401 || status === 403;

/**
 * Whether a failed operation says the token itself is dead.
 *
 * A 401 always does. A 403 usually does not: GitHub answers 403 for a
 * fine-grained token missing one permission ("Resource not accessible by
 * personal access token") and for its secondary rate limit, and Vercel for a
 * project outside the token's scope. Disabling the connection for those
 * would stop every read too, while "Check now" keeps passing. So a 403 counts
 * only when the body names the token as invalid (Vercel sets `invalidToken`).
 */
export const isCredentialRejection = (response: VendorHttpResponse): boolean => {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  const body = response.body;
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>)["error"];
    if (
      typeof error === "object" &&
      error !== null &&
      (error as Record<string, unknown>)["invalidToken"] === true
    ) {
      return true;
    }
  }
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /bad credentials|invalid[ _-]?token|token (?:has )?(?:expired|been revoked|is revoked)/i.test(
    text,
  );
};

/**
 * The vendor's own words about a failed request, short enough to read and long
 * enough to act on. The gateway scrubs credential renderings out of it before
 * anyone sees it; truncating here keeps a 200KB error page out of a log line.
 */
export const describeFailure = (response: VendorHttpResponse): string => {
  const body =
    typeof response.body === "string"
      ? response.body
      : ((): string => {
          try {
            return JSON.stringify(response.body) ?? "";
          } catch {
            return "";
          }
        })();
  return `HTTP ${response.status}${body.length === 0 ? "" : `: ${body.slice(0, 1_000)}`}`;
};

export const vendorFailure = (operationId: string, detail: string, unauthorized?: boolean) =>
  new ConnectionVendorError(
    unauthorized === true ? { operationId, detail, unauthorized: true } : { operationId, detail },
  );

/** Fails the call when the vendor did not answer with success, naming which it was. */
export const expectOk = (
  operationId: string,
  response: VendorHttpResponse,
): Effect.Effect<unknown, ConnectionVendorError> =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response.body)
    : Effect.fail(
        new ConnectionVendorError({
          operationId,
          detail: describeFailure(response),
          status: response.status,
          ...(isCredentialRejection(response) ? { unauthorized: true } : {}),
        }),
      );

/**
 * The one place a credential becomes a header value.
 *
 * A request with neither half fails here rather than going out unauthenticated
 * and coming back as a confusing 401 the owner would read as an expired token.
 */
const authorizationHeader = (
  request: VendorHttpRequest,
): Effect.Effect<string, ConnectionVendorError> => {
  if (request.basic !== undefined) {
    const pair = `${Redacted.value(request.basic.username)}:${Redacted.value(request.basic.password)}`;
    return Effect.succeed(`Basic ${Buffer.from(pair, "utf8").toString("base64")}`);
  }
  return request.bearer === undefined
    ? Effect.fail(
        vendorFailure(request.operationId, "This request was built with no credential to send."),
      )
    : Effect.succeed(`Bearer ${Redacted.value(request.bearer)}`);
};

export const makeFetchVendorHttp = (
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): VendorHttp =>
  Effect.fn("VendorHttp.request")(function* (request: VendorHttpRequest) {
    const authorization = yield* authorizationHeader(request);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(request.url, {
          method: request.method,
          headers: {
            accept: "application/json",
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
            ...request.headers,
            authorization,
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }),
      // The rejection carries the URL we built, never the header we set, but it
      // is still the vendor's text about our request, so it goes through the
      // same detail channel the gateway scrubs.
      catch: (cause) =>
        vendorFailure(request.operationId, `Could not reach the provider: ${String(cause)}`),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        vendorFailure(request.operationId, `Could not read the provider reply: ${String(cause)}`),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].map(([name, value]) => [name.toLowerCase(), value]),
      ),
      body: ((): unknown => {
        if (text.length === 0) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })(),
    };
  });
