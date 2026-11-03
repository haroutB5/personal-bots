import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RequestFailure } from "./failure";
import { backoffMs, describePairFailure, withTimeout } from "./connection";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffMs", () => {
  it("doubles from 2 seconds and stops at 30", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("withTimeout", () => {
  it("passes a result that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  it("fails as a timeout when the work hangs", async () => {
    const pending = withTimeout(new Promise<number>(() => undefined), 1_000);
    const caught = pending.catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toEqual(new RequestFailure({ kind: "timeout" }));
  });
});

describe("describePairFailure", () => {
  it("tells a spent link from a laptop that is off", () => {
    const spent = new RequestFailure({ kind: "http", route: "pair", status: 401, jsonBody: true });
    const down = new RequestFailure({ kind: "network" });
    expect(describePairFailure(spent)).toContain("already used or has expired");
    expect(describePairFailure(down)).toContain("Can't reach your laptop");
  });
});
