import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchServerVersion } from "./compat";

const BASE = "https://relay.example.test/";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchServerVersion", () => {
  it("reads the version the server runs from client-compat", async () => {
    const fetchSpy = vi.fn(
      async (_url: URL | string) =>
        new Response(
          JSON.stringify({
            serverVersion: "1.66.111",
            android: { minimumNativeVersion: "1.66.0" },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchServerVersion(BASE)).resolves.toBe("1.66.111");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://relay.example.test/api/personal/client-compat",
    );
  });

  it("shows no version when the server cannot say", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ serverVersion: null }), { status: 200 })),
    );
    await expect(fetchServerVersion(BASE)).resolves.toBeNull();
  });

  it("shows no version on a server without the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    await expect(fetchServerVersion(BASE)).resolves.toBeNull();
  });
});
