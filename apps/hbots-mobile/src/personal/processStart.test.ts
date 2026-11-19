import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../launcher/nativeLauncher");
});

async function load(nativeLauncher: unknown) {
  vi.resetModules();
  vi.doMock("../launcher/nativeLauncher", () => ({ nativeLauncher }));
  return import("./processStart");
}

describe("process start time", () => {
  it("reads the native process start uptime", async () => {
    const { processStartAt } = await load({ processStartUptimeMs: () => 167_833_489 });

    expect(processStartAt()).toBe(167_833_489);
  });

  it("hands the first chat open the process start once, then nothing", async () => {
    const { takeFirstOpenProcessStart } = await load({ processStartUptimeMs: () => 42_000 });

    expect(takeFirstOpenProcessStart()).toBe(42_000);
    expect(takeFirstOpenProcessStart()).toBeUndefined();
    expect(takeFirstOpenProcessStart()).toBeUndefined();
  });

  it("gives undefined when the module is missing, older, or throws", async () => {
    expect((await load(null)).processStartAt()).toBeUndefined();
    expect((await load({})).processStartAt()).toBeUndefined();
    const thrower = await load({
      processStartUptimeMs: () => {
        throw new Error("native");
      },
    });
    expect(thrower.processStartAt()).toBeUndefined();
    expect(thrower.takeFirstOpenProcessStart()).toBeUndefined();
  });
});
