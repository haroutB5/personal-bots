import { describe, expect, it } from "vite-plus/test";

import { crashDiagBody, isCrashDiagKey } from "./diagBody";

describe("client diag crash body", () => {
  it("names a crash and an ANR path without any content", () => {
    const crash = crashDiagBody("crash", "TypeError", 1_700_000_000_000);
    const anr = crashDiagBody("anr", "ApplicationNotResponding", 1_700_000_000_000);
    expect(crash.path).toBe("/android/crash");
    expect(anr.path).toBe("/android/anr");
    expect(crash.event).toBe("page-boot");
    expect(Object.keys(crash).every(isCrashDiagKey)).toBe(true);
    expect(JSON.stringify(crash)).not.toContain("message");
  });

  it("strips characters the server would reject from an error name", () => {
    expect(crashDiagBody("crash", "Bad\u0000Name!", 1).error).toBe("BadName");
  });
});
