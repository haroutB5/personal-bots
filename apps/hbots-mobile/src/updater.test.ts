import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  offer: vi.fn(async () => undefined),
  snapshot: vi.fn(async () => null),
  confirmInstall: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  openInstallPermission: vi.fn(async () => undefined),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));

import { offerUpdate, resetUpdater } from "./updater";

const RELEASE = {
  version: "1.66.128",
  sha256: "a".repeat(64),
  size: 46_076_721,
  notes: "Session gate",
};

describe("updater generation", () => {
  it("sends the session generation with an offer", async () => {
    const auth = { apkUrl: "https://relay.example.test/apk", bearer: "tok" };

    await offerUpdate(RELEASE, auth, false, 4);

    expect(native.offer).toHaveBeenCalledWith(RELEASE, auth, { manual: false, generation: 4 });
  });

  it("advances the native generation when the session ends", async () => {
    await resetUpdater(5);

    expect(native.reset).toHaveBeenCalledWith(5);
  });
});
