// @effect-diagnostics nodeBuiltinImport:off - the tests serve real HTTP on loopback.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { isCatalogInstallError } from "./errors.ts";
import {
  checkUrl,
  fetchText,
  headSize,
  isPrivateHost,
  openHttps,
  readBounded,
} from "./transport.ts";

type Handler = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void;

interface Served {
  readonly origin: string;
  readonly requests: string[];
  readonly server: NodeHttp.Server;
}

const serve = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<Served>((resume) => {
      const requests: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        handler(request, response);
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as NodeNet.AddressInfo;
        resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, requests, server }));
      });
    }),
    (started) =>
      Effect.callback<void>((resume) => {
        started.server.close(() => resume(Effect.void));
        started.server.closeAllConnections();
      }),
  );

const options = { allowLoopbackHttp: true } as const;
const withClient = <A, E>(self: (http: HttpClient.HttpClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* self(http);
  }).pipe(Effect.provide(FetchHttpClient.layer));

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("expected a failure");
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      return (error as { error: unknown } | undefined)?.error;
    }),
  );

describe("checkUrl", () => {
  it("allows public HTTPS only", () => {
    expect(checkUrl("https://github.com/a/b.zip")?.host).toBe("github.com");
    expect(
      checkUrl("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"),
    ).not.toBeNull();
    for (const refused of [
      "http://github.com/a.zip",
      "ftp://github.com/a.zip",
      "file:///C:/x",
      "https://user:pw@github.com/a.zip",
      "https://127.0.0.1/a",
      "https://localhost/a",
      "https://10.1.2.3/a",
      "https://192.168.0.50/a",
      "https://172.16.0.1/a",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a",
      "https://printer.local/a",
      "not a url",
      "",
    ]) {
      expect(checkUrl(refused), refused).toBeNull();
    }
  });

  it("allows plain HTTP only to loopback and only when a test asks", () => {
    expect(checkUrl("http://127.0.0.1:5/a", { allowLoopbackHttp: true })).not.toBeNull();
    expect(checkUrl("http://127.0.0.1:5/a")).toBeNull();
    expect(checkUrl("http://example.com/a", { allowLoopbackHttp: true })).toBeNull();
    expect(checkUrl("http://10.0.0.1/a", { allowLoopbackHttp: true })).toBeNull();
  });

  it("recognises private hosts", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("github.com")).toBe(false);
  });
});

describe("openHttps", () => {
  it.live("follows a redirect by hand and stops at an answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin, requests } = yield* serve((request, response) => {
          if (request.url === "/start") {
            response.writeHead(302, { location: "/final" });
            response.end();
          } else {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("hello");
          }
        });
        const body = yield* withClient((http) => fetchText(http, `${origin}/start`, 1024, options));
        expect(body).toBe("hello");
        expect(requests).toEqual(["GET /start", "GET /final"]);
      }),
    ),
  );

  it.live("refuses a redirect to plain HTTP on another host, and to a private address", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* serve((request, response) => {
          const target =
            request.url === "/to-http"
              ? "http://example.com/x"
              : request.url === "/to-private"
                ? "https://10.0.0.5/x"
                : "/x";
          response.writeHead(302, { location: target });
          response.end();
        });
        for (const path of ["/to-http", "/to-private"]) {
          const error = yield* failureOf(
            withClient((http) => openHttps(http, { url: `${origin}${path}` }, options)),
          );
          expect(isCatalogInstallError(error), path).toBe(true);
          expect((error as { kind: string }).kind).toBe("network");
          expect((error as { detail: string }).detail).toMatch(
            /redirect somewhere hbots does not allow/u,
          );
        }
      }),
    ),
  );

  it.live("gives up on a redirect loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin, requests } = yield* serve((_request, response) => {
          response.writeHead(302, { location: "/again" });
          response.end();
        });
        const error = yield* failureOf(
          withClient((http) => openHttps(http, { url: `${origin}/again` }, options)),
        );
        expect((error as { detail: string }).detail).toMatch(/redirected too many times/u);
        expect(requests).toHaveLength(6);
      }),
    ),
  );

  it.live("reports an HTTP error by host and status only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* serve((_request, response) => {
          response.writeHead(404);
          response.end("secret-token-in-body");
        });
        const error = yield* failureOf(
          withClient((http) => openHttps(http, { url: `${origin}/a?token=abc` }, options)),
        );
        const detail = (error as { detail: string }).detail;
        expect(detail).toBe(`${new URL(origin).host} answered 404.`);
        expect(detail).not.toContain("token");
      }),
    ),
  );

  it.live("refuses a non-HTTPS first URL without sending anything", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        withClient((http) => openHttps(http, { url: "http://example.com/a" })),
      );
      expect((error as { detail: string }).detail).toMatch(/only downloads over HTTPS/u);
    }),
  );

  it.live("names the host, never the URL, when the connection fails", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        withClient((http) =>
          openHttps(http, { url: "http://127.0.0.1:1/secret/path?token=abc" }, options),
        ),
      );
      const detail = (error as { detail: string }).detail;
      expect(detail).toBe("Could not reach 127.0.0.1:1.");
    }),
  );
});

describe("fetchText and readBounded", () => {
  it.live("stops reading at the limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* serve((_request, response) => {
          response.writeHead(200);
          response.end("x".repeat(5_000));
        });
        const error = yield* failureOf(
          withClient((http) => fetchText(http, `${origin}/big`, 1_000, options)),
        );
        expect((error as { detail: string }).detail).toMatch(/sent more data than expected/u);
        const small = yield* withClient((http) => fetchText(http, `${origin}/big`, 6_000, options));
        expect(small).toHaveLength(5_000);
      }),
    ),
  );

  it.live("enforces the limit on a body that does not declare its length", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* serve((_request, response) => {
          response.writeHead(200, { "transfer-encoding": "chunked" });
          response.write("x".repeat(600));
          response.end("y".repeat(600));
        });
        const error = yield* failureOf(
          withClient((http) =>
            openHttps(http, { url: `${origin}/chunked` }, options).pipe(
              Effect.flatMap(({ response, host }) => readBounded(response, 1_000, host)),
            ),
          ),
        );
        expect((error as { detail: string }).detail).toMatch(/sent more data than expected/u);
      }),
    ),
  );
});

describe("headSize", () => {
  it.live(
    "reads Content-Length through a redirect (GitHub answers the first hop with length 0)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { origin, requests } = yield* serve((request, response) => {
            if (request.url === "/release") {
              response.writeHead(302, { location: "/asset", "content-length": "0" });
            } else {
              response.writeHead(200, { "content-length": "76483830" });
            }
            response.end();
          });
          expect(yield* withClient((http) => headSize(http, `${origin}/release`, options))).toBe(
            76_483_830,
          );
          expect(requests).toEqual(["HEAD /release", "HEAD /asset"]);
        }),
      ),
  );

  it.live("is unknown, never a guess, without a length", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* serve((_request, response) => {
          response.writeHead(200);
          response.end();
        });
        expect(yield* withClient((http) => headSize(http, `${origin}/none`, options))).toBeNull();
      }),
    ),
  );

  it.live("is unknown for an encoded body, whose length is not the file's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { origin } = yield* serve((_request, response) => {
          response.writeHead(200, { "content-length": "100", "content-encoding": "gzip" });
          response.end();
        });
        expect(yield* withClient((http) => headSize(http, `${origin}/gz`, options))).toBeNull();
      }),
    ),
  );
});
