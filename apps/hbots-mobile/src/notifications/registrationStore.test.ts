import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import { parseRegistration } from "./registrationStore";

describe("parseRegistration", () => {
  const good = { token: "t", at: 5, appVersion: "1.2.3", delivery: "ready" };

  it("round-trips a saved registration", () => {
    expect(parseRegistration(JSON.stringify(good))).toEqual(good);
  });

  it("treats nothing as nothing", () => {
    expect(parseRegistration(null)).toBeNull();
  });

  it("rejects damaged or foreign values", () => {
    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...good, token: "" }),
      JSON.stringify({ ...good, at: "5" }),
      JSON.stringify({ ...good, delivery: "on" }),
      JSON.stringify({ ...good, appVersion: 3 }),
    ]) {
      expect(parseRegistration(raw)).toBeNull();
    }
  });
});

describe("parseRegistration after a clear", () => {
  it("reads the blanked entry as nothing saved", () => {
    expect(parseRegistration("")).toBeNull();
  });
});
