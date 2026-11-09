import { describe, expect, it } from "vite-plus/test";

import { RESET_AFTER_FAILURES, shouldResetNetworkClient } from "./reconnectPolicy";

describe("shouldResetNetworkClient", () => {
  it("leaves the first two failures to the normal retry", () => {
    expect(shouldResetNetworkClient(1)).toBe(false);
    expect(shouldResetNetworkClient(2)).toBe(false);
  });

  it("resets the shared HTTP pool from the third failure on", () => {
    expect(RESET_AFTER_FAILURES).toBe(3);
    expect(shouldResetNetworkClient(3)).toBe(true);
    expect(shouldResetNetworkClient(9)).toBe(true);
  });
});
