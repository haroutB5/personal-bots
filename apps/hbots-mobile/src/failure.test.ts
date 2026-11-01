import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { assertSameEnvironment, classifyFailure, type Failure } from "./failure";
import { requestJson } from "./http";

const BASE = new URL("https://relay.example.test/");

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

async function failureOf(run: () => Promise<unknown>): Promise<Failure> {
  try {
    await run();
  } catch (cause) {
    return classifyFailure(cause);
  }
  throw new Error("expected the request to fail");
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const html = (status: number, body = "<html><body>error</body></html>") =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("classifyFailure, signed out", () => {
  it("counts an hbots JSON 401 as signed out", async () => {
    stubFetch(async () => json(401, { code: "auth_invalid" }));
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "authDead", reason: "unauthorized" });
  });

  it("counts a renew 403 as signed out", async () => {
    stubFetch(async () => json(403, { code: "session_not_renewable" }));
    const failure = await failureOf(() => requestJson("renew", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "authDead", reason: "session-ended" });
  });

  it("counts an environment id mismatch as signed out", async () => {
    const failure = await failureOf(async () => assertSameEnvironment("env-stored", "env-other"));
    expect(failure).toEqual({ kind: "authDead", reason: "environment-mismatch" });
  });

  it("accepts the same environment id", () => {
    expect(() => assertSameEnvironment("env-1", "env-1")).not.toThrow();
  });
});

describe("classifyFailure, laptop unreachable", () => {
  it("counts a DNS failure as unreachable", async () => {
    stubFetch(async () => {
      throw new TypeError("Network request failed");
    });
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "unreachable" });
  });

  it("counts a timeout as unreachable", async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("x", "AbortError")),
          );
        }),
    );
    const pending = failureOf(() => requestJson("ticket", new URL("/api/x", BASE), {}, 5_000));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ kind: "unreachable" });
  });

  it.each([502, 530])("counts a Cloudflare %i page as unreachable", async (status) => {
    stubFetch(async () => html(status));
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "unreachable" });
  });

  it("counts a 200 with a non-JSON page as unreachable", async () => {
    stubFetch(async () => html(200, "<html>captive portal</html>"));
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "unreachable" });
  });

  it("counts an HTML 401 from the edge as unreachable, not signed out", async () => {
    stubFetch(async () => html(401));
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "unreachable" });
  });

  it("counts a JSON 403 outside renew as unreachable", async () => {
    stubFetch(async () => json(403, { code: "insufficient_scope" }));
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "unreachable" });
  });

  it("counts a JSON 500 as unreachable", async () => {
    stubFetch(async () => json(500, { code: "internal_error" }));
    const failure = await failureOf(() => requestJson("ticket", new URL("/api/x", BASE)));
    expect(failure).toEqual({ kind: "unreachable" });
  });

  it("counts an unknown thrown value as unreachable", () => {
    expect(classifyFailure("boom")).toEqual({ kind: "unreachable" });
  });
});

describe("requestJson", () => {
  it("returns the parsed body of a 200", async () => {
    stubFetch(async () => json(200, { revoked: true }));
    await expect(requestJson("revoke", new URL("/api/x", BASE))).resolves.toEqual({
      revoked: true,
    });
  });

  it("sends the init through to fetch", async () => {
    const fetchSpy = vi.fn(async (_url: URL | string, _init?: RequestInit) => json(200, {}));
    vi.stubGlobal("fetch", fetchSpy);
    await requestJson("renew", new URL("/api/x", BASE), {
      method: "POST",
      headers: { authorization: "Bearer abc" },
    });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: "Bearer abc" });
  });
});
