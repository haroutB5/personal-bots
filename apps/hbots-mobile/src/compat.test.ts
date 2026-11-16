import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { apkUrlFor, fetchCompat } from "./compat";
import { androidPerfOptimizationOn, resetPerfOffForTest, setPerfOff } from "./perfFlags";

const BASE = "https://relay.example.test/";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPerfOffForTest();
});

function respond(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("fetchCompat", () => {
  it("reads the version, the minimum and the latest APK", async () => {
    const fetchSpy = vi.fn(
      async (_url: URL | string) =>
        new Response(
          JSON.stringify({
            serverVersion: "1.66.113",
            android: {
              minimumNativeVersion: "1.66.110",
              latest: {
                version: "1.66.113",
                sha256: "a".repeat(64),
                size: 46_076_721,
                notes: "Faster reconnect.",
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchCompat(BASE)).resolves.toEqual({
      serverVersion: "1.66.113",
      minimumNativeVersion: "1.66.110",
      latest: {
        version: "1.66.113",
        sha256: "a".repeat(64),
        size: 46_076_721,
        notes: "Faster reconnect.",
      },
      perfOff: [],
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://relay.example.test/api/personal/client-compat",
    );
  });

  it("treats an old server without the android block as no update", async () => {
    respond({ serverVersion: null });
    await expect(fetchCompat(BASE)).resolves.toEqual({
      serverVersion: null,
      minimumNativeVersion: null,
      latest: null,
      perfOff: [],
    });
  });

  it("treats a null latest as no update", async () => {
    respond({
      serverVersion: "1.66.113",
      android: { minimumNativeVersion: "1.66.110", latest: null },
    });
    await expect(fetchCompat(BASE)).resolves.toEqual({
      serverVersion: "1.66.113",
      minimumNativeVersion: "1.66.110",
      latest: null,
      perfOff: [],
    });
  });

  it("shows nothing on a server without the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    await expect(fetchCompat(BASE)).resolves.toBeNull();
  });

  it("shows nothing when the latest release is malformed", async () => {
    respond({
      serverVersion: "1.66.113",
      android: { minimumNativeVersion: "1.66.110", latest: { version: 3 } },
    });
    await expect(fetchCompat(BASE)).resolves.toBeNull();
  });
});

describe("apkUrlFor", () => {
  it("builds the Bearer route from the version only", () => {
    expect(
      apkUrlFor("https://relay.example.test/", {
        version: "1.66.113",
        sha256: "a".repeat(64),
        size: 1,
        notes: "",
      }),
    ).toBe("https://relay.example.test/api/personal/android/apk/1.66.113");
  });
});

describe("the server's perfOff list", () => {
  const withPerfOff = (perfOff?: unknown) => ({
    serverVersion: "1.67.28",
    android: { minimumNativeVersion: "1.66.110", latest: null },
    ...(perfOff === undefined ? {} : { perfOff }),
  });

  it("reads the names and switches that optimisation off", async () => {
    respond(withPerfOff(["android-preload-chat"]));
    const compat = await fetchCompat(BASE);

    expect(compat?.perfOff).toEqual(["android-preload-chat"]);
    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(false);
  });

  it("decodes as empty when a 1.67.27 server omits it, so everything stays on", async () => {
    respond(withPerfOff());
    const compat = await fetchCompat(BASE);

    expect(compat?.perfOff).toEqual([]);
    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(true);
  });

  it("switches back on when a later answer no longer lists it", async () => {
    respond(withPerfOff(["android-preload-chat"]));
    await fetchCompat(BASE);
    respond(withPerfOff([]));
    await fetchCompat(BASE);

    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(true);
  });

  it("keeps the last list when a check fails", async () => {
    respond(withPerfOff(["android-preload-chat"]));
    await fetchCompat(BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
    );

    await expect(fetchCompat(BASE)).resolves.toBeNull();
    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(false);
  });

  it("is ignored by a phone that does not know the field (the 1.67.27 decoder)", () => {
    const oldDecoder = Schema.decodeUnknownSync(
      Schema.Struct({
        serverVersion: Schema.NullOr(Schema.String),
        android: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              minimumNativeVersion: Schema.String,
              latest: Schema.NullOr(Schema.Unknown),
            }),
          ),
        ),
      }),
    );

    expect(oldDecoder(withPerfOff(["android-preload-chat"]))).toEqual({
      serverVersion: "1.67.28",
      android: { minimumNativeVersion: "1.66.110", latest: null },
    });
  });

  it.each([
    ["a string", "android-preload-chat"],
    ["null", null],
    ["a number", 3],
    ["an object", { "android-preload-chat": true }],
    ["a list with a non-string in it", ["android-preload-chat", 4]],
  ])(
    "keeps the rest of the answer and switches nothing off when perfOff is %s",
    async (_name, perfOff) => {
      setPerfOff(["android-update-on-reconnect"]);
      respond({
        serverVersion: "1.67.28",
        android: {
          minimumNativeVersion: "1.66.110",
          latest: {
            version: "1.67.28",
            sha256: "b".repeat(64),
            size: 55_000_000,
            notes: "",
          },
        },
        perfOff,
      });

      await expect(fetchCompat(BASE)).resolves.toEqual({
        serverVersion: "1.67.28",
        minimumNativeVersion: "1.66.110",
        latest: {
          version: "1.67.28",
          sha256: "b".repeat(64),
          size: 55_000_000,
          notes: "",
        },
        perfOff: [],
      });
      expect(androidPerfOptimizationOn("android-preload-chat")).toBe(true);
      expect(androidPerfOptimizationOn("android-update-on-reconnect")).toBe(true);
    },
  );
});
