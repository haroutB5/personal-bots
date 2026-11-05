import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    reset: native.reset,
    isOnline: () => true,
    canReachNetwork: async () => true,
  }),
}));

import { resetNetworkClient } from "./networkReset";

afterEach(() => {
  vi.useRealTimers();
  native.reset.mockReset();
});

describe("resetNetworkClient", () => {
  it("stops waiting when the native reset never settles", async () => {
    vi.useFakeTimers();
    native.reset.mockReturnValue(new Promise<boolean>(() => {}));
    const done = resetNetworkClient();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBeUndefined();
  });

  it("waits for a reset that does settle", async () => {
    native.reset.mockResolvedValue(true);
    await expect(resetNetworkClient()).resolves.toBeUndefined();
    expect(native.reset).toHaveBeenCalledTimes(1);
  });
});
