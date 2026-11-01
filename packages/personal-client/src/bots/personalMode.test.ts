import { describe, expect, it } from "@effect/vitest";

import { createMemoryKeyValueStore } from "../testing/fakes.ts";
import { isPersonalPath, readDeveloperView, setDeveloperView } from "./personalMode.ts";

describe("developer view on the key value port", () => {
  it("is off until chosen, on after it is set, and off again after it is cleared", () => {
    const kv = createMemoryKeyValueStore();
    expect(readDeveloperView(kv)).toBe(false);
    setDeveloperView(kv, true);
    expect(kv.getItem("t3.personal.developerView")).toBe("1");
    expect(readDeveloperView(kv)).toBe(true);
    setDeveloperView(kv, false);
    expect(kv.getItem("t3.personal.developerView")).toBeNull();
    expect(readDeveloperView(kv)).toBe(false);
  });

  it("reads off and does not throw when the store throws", () => {
    const throwing = {
      ...createMemoryKeyValueStore(),
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readDeveloperView(throwing)).toBe(false);
    expect(() => setDeveloperView(throwing, true)).not.toThrow();
  });
});

describe("isPersonalPath", () => {
  it("claims the personal shell paths and leaves the upstream ones", () => {
    expect(["/bots", "/bots/b1/t1", "/tasks/", "/computer", "/files"].map(isPersonalPath)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["/", "/settings", "/thread/abc"].map(isPersonalPath)).toEqual([false, false, false]);
  });
});
