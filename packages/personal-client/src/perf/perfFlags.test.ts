import { describe, expect, it } from "@effect/vitest";

import { createMemoryKeyValueStore } from "../testing/fakes.ts";
import { PERF_OFF_STORAGE_KEY, perfOptimizationOn } from "./perfFlags.ts";

describe("perfOptimizationOn", () => {
  it("is on by default and off when listed", () => {
    expect(perfOptimizationOn(createMemoryKeyValueStore(), "preload-chat")).toBe(true);
    const listed = createMemoryKeyValueStore({ [PERF_OFF_STORAGE_KEY]: " rum , preload-chat" });
    expect(perfOptimizationOn(listed, "preload-chat")).toBe(false);
    expect(perfOptimizationOn(listed, "rum")).toBe(false);
    const other = createMemoryKeyValueStore({ [PERF_OFF_STORAGE_KEY]: "rum" });
    expect(perfOptimizationOn(other, "preload-chat")).toBe(true);
  });

  it("stays on when the store throws", () => {
    const throwing = {
      ...createMemoryKeyValueStore(),
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(perfOptimizationOn(throwing, "preload-chat")).toBe(true);
  });
});
