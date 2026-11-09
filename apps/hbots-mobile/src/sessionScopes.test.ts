import { describe, expect, it } from "vite-plus/test";

import { canManageDevices, grantedScopes } from "./sessionScopes";

describe("canManageDevices", () => {
  it("is false for the standard scopes a Connections link grants", () => {
    expect(
      canManageDevices(
        "orchestration:read orchestration:operate terminal:operate review:write relay:read",
      ),
    ).toBe(false);
  });

  it("is true when both access scopes were granted", () => {
    expect(canManageDevices("orchestration:read access:read access:write relay:read")).toBe(true);
  });

  it("is false with only one of the access scopes", () => {
    expect(canManageDevices("orchestration:read access:read")).toBe(false);
    expect(canManageDevices("orchestration:read access:write")).toBe(false);
  });

  it("is false for an empty scope string", () => {
    expect(canManageDevices("")).toBe(false);
  });
});

describe("grantedScopes", () => {
  it("splits the pairing scope string and drops unknown names", () => {
    expect(grantedScopes("orchestration:read access:read contact:write")).toEqual([
      "orchestration:read",
      "access:read",
    ]);
  });

  it("keeps legacy scope names the server still issues", () => {
    expect(grantedScopes("orchestration:read filesystem:read review:write")).toEqual([
      "orchestration:read",
      "filesystem:read",
      "review:write",
    ]);
  });

  it("returns an empty list for an empty scope string", () => {
    expect(grantedScopes("")).toEqual([]);
  });
});
