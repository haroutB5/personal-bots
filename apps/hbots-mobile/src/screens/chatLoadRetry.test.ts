import { describe, expect, it } from "vite-plus/test";

import { chatLoadRetryDelayMs } from "./chatLoadRetry";

describe("chatLoadRetryDelayMs", () => {
  it("waits a little longer each time, three times", () => {
    expect([0, 1, 2].map(chatLoadRetryDelayMs)).toEqual([2_000, 6_000, 12_000]);
  });

  it("gives up after the third retry so the error and its button can show", () => {
    expect(chatLoadRetryDelayMs(3)).toBeNull();
  });
});
