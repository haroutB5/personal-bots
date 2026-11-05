import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { currentOrigin, isLocalOnlyOrigin } from "./routineHook.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("currentOrigin", () => {
  it("reads the served origin, which is the tunnel host when the phone is out", () => {
    vi.stubGlobal("window", { location: { origin: "https://box.example.ts.net" } });
    expect(currentOrigin()).toBe("https://box.example.ts.net");
  });

  it("returns null with no document rather than inventing an origin", () => {
    vi.stubGlobal("window", undefined);
    expect(currentOrigin()).toBeNull();
  });
});

describe("isLocalOnlyOrigin", () => {
  it("knows the addresses only this computer can reach", () => {
    expect(isLocalOnlyOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalOnlyOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalOnlyOrigin("https://box.example.ts.net")).toBe(false);
  });
});
