// @effect-diagnostics nodeBuiltinImport:off - a real local HTTPS server is the point of these tests.
// @effect-diagnostics globalTimers:off
import type * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import type { PersonalSecretPlacement } from "@t3tools/contracts";

import {
  callWithSecrets,
  isPublicAddress,
  placeholderNames,
  prepareBrokerRequest,
  SecretBrokerError,
  secretBrokerEnabled,
  type BrokerDeps,
  type BrokerSecret,
} from "./secretBroker.ts";
import { makeSecretRedactor } from "./secretRedaction.ts";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./secretBrokerTestCert.ts";

const VALUE = "vercel_pat_Zx9Qk2LmN4pR7sT0uV3wY6aB8cD1eF5g";
const OTHER_VALUE = "other_service_key_0123456789abcdef";

const secret = (
  name: string,
  origins: ReadonlyArray<string>,
  mode: "brokered" | "env" = "brokered",
  value = VALUE,
  placement: PersonalSecretPlacement = {},
): BrokerSecret => ({ name, mode, origins, value, placement });

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretBrokerError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("isPublicAddress", () => {
  it("accepts public addresses and refuses every private, loopback and reserved one", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "76.76.21.21", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "not an address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("placeholderNames", () => {
  it("finds every key a text names, with or without a transform", () => {
    expect(
      placeholderNames(
        "a {{secret:ONE}} b {{ secret:TWO|base64 }} c {{secret:ONE}} {{secret:bad}}",
      ),
    ).toEqual(["ONE", "TWO", "ONE"]);
  });
});

describe("prepareBrokerRequest", () => {
  const origin = "https://api.vercel.com";
  const keys = [secret("VERCEL_TOKEN", [origin]), secret("ENV_KEY", [], "env")];
  const base = {
    method: "GET",
    url: `${origin}/v9/projects`,
    headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
  };

  const open = [
    secret("VERCEL_TOKEN", [origin], "brokered", VALUE, { anywhere: true, header: "x-key" }),
  ];

  it("puts the value into a header, the query, the path and the body when the owner allowed it", () => {
    const prepared = prepareBrokerRequest(
      {
        method: "post",
        url: `${origin}/v1/{{secret:VERCEL_TOKEN}}/x?key={{secret:VERCEL_TOKEN}}&a=1`,
        headers: {
          "X-Key": "{{secret:VERCEL_TOKEN}}",
          Authorization: "Basic {{secret:VERCEL_TOKEN|base64}}",
        },
        body: '{"token":"{{secret:VERCEL_TOKEN}}"}',
      },
      open,
    );
    expect(prepared.method).toBe("POST");
    expect(prepared.origin).toBe(origin);
    expect(prepared.url.pathname).toBe(`/v1/${VALUE}/x`);
    expect(prepared.url.searchParams.get("key")).toBe(VALUE);
    expect(prepared.headers["X-Key"]).toBe(VALUE);
    expect(prepared.headers.Authorization).toBe(`Basic ${Buffer.from(VALUE).toString("base64")}`);
    expect(prepared.body?.toString()).toBe(`{"token":"${VALUE}"}`);
    expect(prepared.secretsUsed).toEqual(["VERCEL_TOKEN"]);
  });

  it("by default allows the key only in the Authorization header", () => {
    const strictKeys = [secret("VERCEL_TOKEN", [origin])];
    expect(
      prepareBrokerRequest(
        {
          method: "GET",
          url: `${origin}/v9/projects`,
          headers: { authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
        },
        strictKeys,
      ).headers.authorization,
    ).toBe(`Bearer ${VALUE}`);
    const cases: ReadonlyArray<readonly [string, Parameters<typeof prepareBrokerRequest>[0]]> = [
      ["query", { method: "GET", url: `${origin}/x?token={{secret:VERCEL_TOKEN}}` }],
      ["path", { method: "GET", url: `${origin}/x/{{secret:VERCEL_TOKEN}}` }],
      ["body", { method: "POST", url: `${origin}/x`, body: '{"t":"{{secret:VERCEL_TOKEN}}"}' }],
      [
        "other header",
        { method: "GET", url: `${origin}/x`, headers: { "X-Api-Key": "{{secret:VERCEL_TOKEN}}" } },
      ],
    ];
    for (const [label, request] of cases) {
      const message = refusal(() => prepareBrokerRequest(request, strictKeys));
      expect(message, label).toContain("Authorization header");
      expect(message, label).not.toContain(VALUE);
    }
  });

  it("allows one more header name the owner set, and no other", () => {
    const withHeader = [
      secret("VERCEL_TOKEN", [origin], "brokered", VALUE, { header: "x-api-key" }),
    ];
    expect(
      prepareBrokerRequest(
        { method: "GET", url: `${origin}/x`, headers: { "X-API-Key": "{{secret:VERCEL_TOKEN}}" } },
        withHeader,
      ).headers["X-API-Key"],
    ).toBe(VALUE);
    expect(
      refusal(() =>
        prepareBrokerRequest(
          { method: "GET", url: `${origin}/x`, headers: { "X-Other": "{{secret:VERCEL_TOKEN}}" } },
          withHeader,
        ),
      ),
    ).toContain("x-other");
    // The header opt-in does not open the URL.
    expect(
      refusal(() =>
        prepareBrokerRequest(
          { method: "GET", url: `${origin}/x?k={{secret:VERCEL_TOKEN}}` },
          withHeader,
        ),
      ),
    ).toContain("not in the URL");
  });

  it("keeps a well-known key header-only (GITHUB_TOKEN to api.github.com)", () => {
    const github = [secret("GITHUB_TOKEN", ["https://api.github.com"])];
    expect(
      prepareBrokerRequest(
        {
          method: "GET",
          url: "https://api.github.com/user",
          headers: { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" },
        },
        github,
      ).secretsUsed,
    ).toEqual(["GITHUB_TOKEN"]);
    expect(
      refusal(() =>
        prepareBrokerRequest(
          {
            method: "GET",
            url: "https://api.github.com/user?access_token={{secret:GITHUB_TOKEN}}",
          },
          github,
        ),
      ),
    ).toContain("not in the URL");
  });

  it("holds a key to its path prefix, on a segment boundary, whatever the spelling", () => {
    const scoped = [
      secret("VERCEL_TOKEN", [origin], "brokered", VALUE, { anywhere: true, pathPrefix: "/v1" }),
    ];
    const call = (path: string) =>
      prepareBrokerRequest(
        {
          method: "GET",
          url: `${origin}${path}`,
          headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
        },
        scoped,
      );
    expect(call("/v1").url.pathname).toBe("/v1");
    expect(call("/v1/projects?x=1").url.pathname).toBe("/v1/projects");
    for (const path of ["/v10", "/v2/x", "/", "/v1/../admin", "/v1/%2e%2e/admin", "/other/v1"]) {
      expect(
        refusal(() => call(path)),
        path,
      ).toContain("under /v1");
    }
  });

  it("holds a key to its method list", () => {
    const readOnly = [
      secret("VERCEL_TOKEN", [origin], "brokered", VALUE, { methods: ["GET", "HEAD"] }),
    ];
    const call = (method: string) =>
      prepareBrokerRequest(
        {
          method,
          url: `${origin}/x`,
          headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
        },
        readOnly,
      );
    expect(call("get").method).toBe("GET");
    expect(refusal(() => call("DELETE"))).toContain("may only be used with GET, HEAD");
  });

  it("builds a Basic header from a username and a key", () => {
    const prepared = prepareBrokerRequest(
      { method: "GET", url: `${origin}/x`, basicAuth: { username: "me", secret: "VERCEL_TOKEN" } },
      keys,
    );
    expect(prepared.headers.Authorization).toBe(
      `Basic ${Buffer.from(`me:${VALUE}`).toString("base64")}`,
    );
  });

  it("refuses a key bound to another origin, and says where it is bound", () => {
    const message = refusal(() =>
      prepareBrokerRequest({ ...base, url: "https://evil.example.com/steal" }, keys),
    );
    expect(message).toContain("not allowed to be sent to https://evil.example.com");
    expect(message).toContain(origin);
    expect(message).not.toContain(VALUE);
  });

  it("treats another port and another subdomain as another origin", () => {
    for (const url of [
      `${origin}:8443/x`,
      "https://sub.api.vercel.com/x",
      "https://vercel.com/x",
    ]) {
      expect(refusal(() => prepareBrokerRequest({ ...base, url }, keys))).toContain("not allowed");
    }
  });

  it("refuses a key saved as an environment variable", () => {
    const message = refusal(() =>
      prepareBrokerRequest({ ...base, headers: { A: "{{secret:ENV_KEY}}" } }, keys),
    );
    expect(message).toContain("environment variable");
  });

  it("refuses an unknown key and a call that uses no key at all", () => {
    expect(
      refusal(() => prepareBrokerRequest({ ...base, headers: { A: "{{secret:NOPE}}" } }, keys)),
    ).toContain("No saved key named NOPE");
    expect(
      refusal(() => prepareBrokerRequest({ method: "GET", url: `${origin}/x` }, keys)),
    ).toContain("only sends requests that use a saved key");
  });

  it("refuses non-https, logins, IP addresses, localhost, internal names and a key in the host", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["http://api.vercel.com/x", "https"],
      ["ftp://api.vercel.com/x", "https"],
      ["https://user:pw@api.vercel.com/x", "login"],
      ["https://api.vercel.com@evil.example/x", "login"],
      ["https://127.0.0.1/x", "not allowed"],
      ["https://[::1]/x", "not allowed"],
      ["https://localhost/x", "not allowed"],
      ["https://intranet.local/x", "not allowed"],
      ["https://2130706433/x", "not allowed"],
      ["https://{{secret:VERCEL_TOKEN}}.vercel.com/x", "host"],
    ];
    for (const [url, expected] of cases) {
      expect(
        refusal(() => prepareBrokerRequest({ ...base, url }, keys)),
        url,
      ).toContain(expected);
    }
  });

  it("refuses headers the transport owns, line breaks, a body on GET and a bad method", () => {
    expect(
      refusal(() =>
        prepareBrokerRequest({ ...base, headers: { ...base.headers, Host: "x" } }, keys),
      ),
    ).toContain("set by the server");
    expect(
      refusal(() =>
        prepareBrokerRequest({ ...base, headers: { ...base.headers, "X-A": "a\r\nX-B: b" } }, keys),
      ),
    ).toContain("line break");
    expect(refusal(() => prepareBrokerRequest({ ...base, body: "x" }, keys))).toContain("no body");
    expect(refusal(() => prepareBrokerRequest({ ...base, method: "TRACE" }, keys))).toContain(
      "not allowed",
    );
    expect(
      refusal(() =>
        prepareBrokerRequest({ ...base, method: "POST", body: "x".repeat(300_000) }, keys),
      ),
    ).toContain("over");
  });

  it("never puts a value in a refusal", () => {
    const attempts = [
      () => prepareBrokerRequest({ ...base, url: "https://evil.example.com/x" }, keys),
      () => prepareBrokerRequest({ ...base, headers: { A: "{{secret:ENV_KEY}}" } }, keys),
      () => prepareBrokerRequest({ ...base, url: `http://api.vercel.com/${VALUE}` }, keys),
    ];
    for (const attempt of attempts) expect(refusal(attempt)).not.toContain(VALUE);
  });
});

describe("secretBrokerEnabled", () => {
  it("is on unless PERSONAL_SECRET_BROKER says off", () => {
    expect(secretBrokerEnabled({})).toBe(true);
    expect(secretBrokerEnabled({ PERSONAL_SECRET_BROKER: "off" })).toBe(false);
    expect(secretBrokerEnabled({ T3CODE_PERSONAL_SECRET_BROKER: "0" })).toBe(false);
    expect(secretBrokerEnabled({ PERSONAL_SECRET_BROKER: "on" })).toBe(true);
  });
});

/** A real HTTPS server on loopback that the broker reaches through an injected resolver and CA. */
describe("callWithSecrets against a local HTTPS server", () => {
  interface Seen {
    readonly method: string | undefined;
    readonly url: string | undefined;
    readonly headers: NodeJS.Dict<string | string[]>;
    readonly body: string;
  }
  const seen: Array<Seen> = [];
  let main: NodeHttps.Server;
  let elsewhere: NodeHttps.Server;
  let elsewhereHits = 0;
  let port = 0;
  let elsewherePort = 0;

  const handler =
    (hits: () => void): NodeHttp.RequestListener =>
    (request, response) => {
      hits();
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ method: request.method, url: request.url, headers: request.headers, body });
        const path = new URL(request.url ?? "/", "https://x").pathname;
        switch (path) {
          case "/echo":
            // An API that hands the credential back: the broker must not pass it on.
            response.setHeader("content-type", "application/json");
            response.setHeader("x-request-id", "req-1");
            response.setHeader("set-cookie", "session=abc");
            response.end(
              JSON.stringify({
                authorization: request.headers.authorization,
                url: request.url,
                body,
              }),
            );
            return;
          case "/redirect-same":
            response.statusCode = 302;
            response.setHeader("location", "/echo?from=redirect");
            response.end();
            return;
          case "/redirect-off":
            response.statusCode = 302;
            response.setHeader("location", `https://other.test.example:${elsewherePort}/landing`);
            response.end();
            return;
          case "/loop":
            response.statusCode = 302;
            response.setHeader("location", "/loop");
            response.end();
            return;
          case "/big":
            response.setHeader("content-type", "text/plain");
            response.end("a".repeat(5_000_000));
            return;
          case "/binary":
            response.setHeader("content-type", "image/png");
            response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]));
            return;
          case "/slow":
            setTimeout(() => response.end("late"), 5_000).unref();
            return;
          case "/cut":
            // The key straddles the 1,024 byte cap the test asks for.
            response.setHeader("content-type", "text/plain");
            response.end(`${"a".repeat(1_014)}${VALUE}${"b".repeat(100)}`);
            return;
          case "/b64":
            response.setHeader("content-type", "text/plain");
            response.end(`Basic ${Buffer.from(`user:${VALUE}`).toString("base64")}`);
            return;
          default:
            response.statusCode = 404;
            response.end("nothing");
        }
      });
    };

  const listen = (server: NodeHttps.Server) =>
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as NodeNet.AddressInfo).port));
    });

  beforeAll(async () => {
    main = NodeHttps.createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      handler(() => {}),
    );
    elsewhere = NodeHttps.createServer(
      { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
      handler(() => {
        elsewhereHits += 1;
      }),
    );
    port = await listen(main);
    elsewherePort = await listen(elsewhere);
  });

  afterAll(async () => {
    await Promise.all(
      [main, elsewhere].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const origin = () => `https://api.test.example:${port}`;
  const keys = () => [
    secret("VERCEL_TOKEN", [origin()]),
    secret("OTHER_KEY", [origin()], "brokered", OTHER_VALUE, { header: "x-other" }),
  ];
  /** A key the owner allowed in the URL and body as well. */
  const openKeys = () => [
    secret("VERCEL_TOKEN", [origin()], "brokered", VALUE, { anywhere: true }),
  ];

  /** The test resolver sends every name to loopback, and allows it: the CA is the test's own. */
  const lenient = (extra: Partial<BrokerDeps> = {}): BrokerDeps => ({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isAddressAllowed: () => true,
    requestOptions: { ca: TEST_TLS_CERT },
    redactor: makeSecretRedactor(),
    ...extra,
  });

  /** The same, with the real address rule: nothing private may be connected to. */
  const strict = (): BrokerDeps => {
    const { isAddressAllowed: _allowed, ...rest } = lenient();
    return rest;
  };

  it("injects the key and never returns it, even when the API echoes it back", async () => {
    seen.length = 0;
    const redactor = makeSecretRedactor();
    redactor.set("VERCEL_TOKEN", VALUE);
    const result = await callWithSecrets(
      {
        method: "POST",
        url: `${origin()}/echo?key={{secret:VERCEL_TOKEN}}`,
        headers: {
          Authorization: "Bearer {{secret:VERCEL_TOKEN}}",
          "Content-Type": "application/json",
        },
        body: '{"t":"{{secret:VERCEL_TOKEN}}"}',
      },
      openKeys(),
      lenient({ redactor }),
    );
    // The server really received the value, in all three places.
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${VALUE}`);
    expect(seen[0]?.url).toContain(`key=${encodeURIComponent(VALUE)}`);
    expect(seen[0]?.body).toBe(`{"t":"${VALUE}"}`);
    // And the bot did not.
    expect(result.status).toBe(200);
    expect(result.origin).toBe(origin());
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(JSON.stringify(result)).not.toContain(encodeURIComponent(VALUE));
    expect(result.body).toContain("[secret VERCEL_TOKEN]");
    expect(result.headers["x-request-id"]).toBe("req-1");
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.secretsUsed).toEqual(["VERCEL_TOKEN"]);
  });

  it("masks the value even when the redactor has not learned it yet", async () => {
    const result = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/echo`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      lenient(),
    );
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(result.body).toContain("[secret VERCEL_TOKEN]");
  });

  it("masks the key in its base64 spelling too", async () => {
    const redactor = makeSecretRedactor();
    redactor.set("VERCEL_TOKEN", VALUE);
    const result = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/b64`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      lenient({ redactor }),
    );
    expect(result.body).not.toContain(Buffer.from(`user:${VALUE}`).toString("base64"));
    expect(result.body).toContain("[secret VERCEL_TOKEN]");
  });

  it("follows a same-origin redirect and sends the key again", async () => {
    seen.length = 0;
    const result = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/redirect-same`,
        headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      lenient(),
    );
    expect(result.redirects).toBe(1);
    expect(result.status).toBe(200);
    expect(seen.map((entry) => entry.url)).toEqual(["/redirect-same", "/echo?from=redirect"]);
    expect(seen[1]?.headers.authorization).toBe(`Bearer ${VALUE}`);
  });

  it("refuses a redirect to another origin and sends nothing there", async () => {
    elsewhereHits = 0;
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/redirect-off`,
        headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      lenient(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as Error).message).toContain("different origin");
    expect((error as Error).message).not.toContain(VALUE);
    expect(elsewhereHits).toBe(0);
  });

  it("gives up on a redirect loop", async () => {
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/loop`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      lenient(),
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("redirects");
  });

  it("cuts a large response at the cap and says so", async () => {
    const result = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/big`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
        maxResponseBytes: 4096,
      },
      keys(),
      lenient(),
    );
    expect(result.truncated).toBe(true);
    expect(result.bodyBytes).toBe(4096);
    expect(result.body?.length).toBe(4096);
  });

  it("does not return a binary body", async () => {
    const result = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/binary`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      lenient(),
    );
    expect(result.body).toBeNull();
    expect(result.bodyBytes).toBe(7);
  });

  it("times out", async () => {
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/slow`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
        timeoutMs: 1_000,
      },
      keys(),
      lenient(),
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("timed out");
  });

  it("refuses a name that resolves to a private address, and never connects", async () => {
    seen.length = 0;
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/echo`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      // The real address rule, a name that points at loopback.
      strict(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as Error).message).toContain("private, loopback or otherwise internal");
    expect(seen).toEqual([]);
  });

  it("refuses an answer that mixes a public and a private address", async () => {
    seen.length = 0;
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/echo`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      {
        ...strict(),
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      },
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("private, loopback or otherwise internal");
    expect(seen).toEqual([]);
  });

  it("does not accept a certificate it was not told to trust", async () => {
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/echo`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
      },
      keys(),
      { ...lenient(), requestOptions: {} },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as Error).message).toContain("certificate");
  });

  it("uses two keys in one call", async () => {
    seen.length = 0;
    const result = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/echo`,
        headers: { Authorization: "{{secret:VERCEL_TOKEN}}", "X-Other": "{{secret:OTHER_KEY}}" },
      },
      keys(),
      lenient(),
    );
    expect(result.secretsUsed.toSorted()).toEqual(["OTHER_KEY", "VERCEL_TOKEN"]);
    expect(seen[0]?.headers.authorization).toBe(VALUE);
    expect(seen[0]?.headers["x-other"]).toBe(OTHER_VALUE);
  });

  it("drops a tail of a truncated response that could be the start of a key", async () => {
    const redactor = makeSecretRedactor();
    redactor.set("VERCEL_TOKEN", VALUE);
    for (const known of [redactor, makeSecretRedactor()]) {
      const result = await callWithSecrets(
        {
          method: "GET",
          url: `${origin()}/cut`,
          headers: { Authorization: "{{secret:VERCEL_TOKEN}}" },
          maxResponseBytes: 1024,
        },
        keys(),
        lenient({ redactor: known }),
      );
      expect(result.truncated).toBe(true);
      // Ten characters of the key were inside the cap; none of them are shown.
      expect(result.body).toBe("a".repeat(1_014));
      expect(JSON.stringify(result)).not.toContain(VALUE.slice(0, 6));
    }
  });

  it("holds a key's path prefix and methods on a same-origin redirect too", async () => {
    seen.length = 0;
    const scoped = [
      secret("VERCEL_TOKEN", [origin()], "brokered", VALUE, { pathPrefix: "/redirect-same" }),
    ];
    const error = await callWithSecrets(
      {
        method: "GET",
        url: `${origin()}/redirect-same`,
        headers: { Authorization: "Bearer {{secret:VERCEL_TOKEN}}" },
      },
      scoped,
      lenient(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretBrokerError);
    expect((error as Error).message).toContain("somewhere this key may not go");
    // The first hop was allowed; nothing went to the redirect target.
    expect(seen.map((entry) => entry.url)).toEqual(["/redirect-same"]);
  });
});
