import type { PersonalTaskWorkRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workRecordIsEmpty } from "./workRecordModel";

const record = (overrides: Partial<PersonalTaskWorkRecord> = {}): PersonalTaskWorkRecord => ({
  objective: "Ship the parser",
  decisions: [],
  evidence: [],
  outstanding: [],
  nextStep: "",
  lastStatus: null,
  lastResult: "",
  updates: [],
  updatedAt: "2026-11-05T10:00:00.000Z",
  ...overrides,
});

describe("workRecordIsEmpty", () => {
  it("is empty only when nothing but the objective is there", () => {
    expect(workRecordIsEmpty(record())).toBe(true);
    expect(workRecordIsEmpty(record({ nextStep: "Open the PR" }))).toBe(false);
    expect(workRecordIsEmpty(record({ decisions: ["Use the shared client"] }))).toBe(false);
    expect(workRecordIsEmpty(record({ evidence: [{ label: "log", ref: "/tmp/a.log" }] }))).toBe(
      false,
    );
    expect(workRecordIsEmpty(record({ lastResult: "Built and pushed" }))).toBe(false);
  });
});
