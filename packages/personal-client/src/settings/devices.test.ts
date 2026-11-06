import type { AuthSessionId, PersonalDevice } from "@t3tools/contracts";

import { describe, expect, it } from "vite-plus/test";

import { deviceKindLabel, deviceRow } from "./devices.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");

const device = (overrides: Partial<PersonalDevice> = {}): PersonalDevice =>
  ({
    sessionId: "phone" as AuthSessionId,
    label: "Find X9 Pro",
    deviceType: "mobile",
    os: "android",
    signedInAt: { epochMilliseconds: NOW - 3_600_000 },
    lastSeenAt: { epochMilliseconds: NOW - 300_000 },
    relationship: "other",
    ...overrides,
  }) as PersonalDevice;

describe("device rows", () => {
  it("names the device kind", () => {
    expect(deviceKindLabel(device())).toBe("Phone");
    expect(deviceKindLabel(device({ deviceType: "desktop" }))).toBe("Browser");
  });

  it("marks this device and never offers revoke for it", () => {
    const row = deviceRow(device({ relationship: "this-device" }), NOW);
    expect(row.detail).toBe("This device · Last seen 5m");
    expect(row.canRevoke).toBe(false);
  });

  it("shows the kind, OS and last seen for another device", () => {
    const row = deviceRow(device(), NOW);
    expect(row.title).toBe("Find X9 Pro");
    expect(row.detail).toBe("Phone · android · Last seen 5m");
    expect(row.canRevoke).toBe(true);
  });

  it("falls back to the sign-in time when the device never connected", () => {
    const row = deviceRow(device({ lastSeenAt: null }), NOW);
    expect(row.detail).toBe("Phone · android · Signed in 1h");
  });
});
