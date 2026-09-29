import { describe, expect, it } from "vite-plus/test";

import { PROGRESS_REFRESH_MS, progressRefreshDelayMs } from "./useWorkingProgress";

describe("progressRefreshDelayMs", () => {
  it("reads at once the first time, and holds later reads to one per interval", () => {
    expect(progressRefreshDelayMs(0, 1_000_000)).toBe(0);
    expect(progressRefreshDelayMs(1_000_000, 1_000_000)).toBe(PROGRESS_REFRESH_MS);
    expect(progressRefreshDelayMs(1_000_000, 1_001_000)).toBe(PROGRESS_REFRESH_MS - 1_000);
    expect(progressRefreshDelayMs(1_000_000, 1_000_000 + PROGRESS_REFRESH_MS + 1)).toBe(0);
  });
});
