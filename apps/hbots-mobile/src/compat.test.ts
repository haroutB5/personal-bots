import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { apkUrlFor, fetchCompat } from "./compat";

const BASE = "https://relay.example.test/";

afterEach(() => {
  vi.unstubAllGlobals();
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
