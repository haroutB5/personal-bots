import { gunzipSync } from "node:zlib";

import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { gzipRequestBody } from "./traceGzip";

const json = JSON.stringify({
  resourceSpans: Array.from({ length: 50 }, () => ({ name: "span" })),
});
const request = () =>
  HttpClientRequest.post("http://localhost/api/observability/v1/traces").pipe(
    HttpClientRequest.bodyText(json, "application/json"),
  );

describe("gzipRequestBody", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the body gzipped with the same content type", async () => {
    const next = await Effect.runPromise(gzipRequestBody(request()));
    expect(next.headers["content-encoding"]).toBe("gzip");
    if (next.body._tag !== "Uint8Array") throw new Error("expected bytes");
    expect(next.body.contentType).toBe("application/json");
    expect(next.body.body.length).toBeLessThan(json.length / 4);
    expect(gunzipSync(next.body.body).toString("utf8")).toBe(json);
  });

  it("sends plain JSON while the switch is off", async () => {
    // The unit project has no DOM: a one-key stand-in for localStorage.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "bots:perf-off" ? "trace-gzip" : null),
    });
    const next = await Effect.runPromise(gzipRequestBody(request()));
    expect(next.headers["content-encoding"]).toBeUndefined();
  });
});
