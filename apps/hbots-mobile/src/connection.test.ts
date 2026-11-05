import { describe, expect, it } from "vite-plus/test";

import { RequestFailure } from "./failure";
import { backoffMs, describePairFailure } from "./connection";

describe("backoffMs", () => {
  it("doubles from 1 second and stops at 4, inside the reconnect budget", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([
      1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000,
    ]);
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
