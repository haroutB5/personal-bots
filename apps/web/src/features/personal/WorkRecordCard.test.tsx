import type { PersonalTaskWorkRecord } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WorkRecordCard, workRecordIsEmpty } from "./WorkRecordCard";

const record = (overrides: Partial<PersonalTaskWorkRecord> = {}): PersonalTaskWorkRecord => ({
  objective: "Animate the avatars.",
  decisions: [],
  evidence: [],
  outstanding: [],
  nextStep: "",
  lastStatus: null,
  lastResult: "",
  updates: [],
  updatedAt: "2026-10-04T20:00:00.000Z",
  ...overrides,
});

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const text = (node: unknown): string => {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object" && "children" in value) {
      walk((value as { children: unknown }).children);
    }
  };
  walk(node);
  return parts.join("");
};

describe("WorkRecordCard", () => {
  it("shows nothing for a record that only holds its objective", () => {
    expect(workRecordIsEmpty(record())).toBe(true);
    act(() => {
      renderer = create(<WorkRecordCard record={record()} />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("is tucked away and lists what the task keeps", () => {
    act(() => {
      renderer = create(
        <WorkRecordCard
          record={record({
            decisions: ["Keep CSS only."],
            evidence: [{ label: "branch", ref: "feat/avatars" }],
            outstanding: ["Two avatars"],
            nextStep: "Animate the third",
            lastStatus: "completed",
            lastResult: "Two of four done.",
            updates: [{ at: "2026-10-04T20:01:00.000Z", text: "Do two more." }],
          })}
        />,
      );
    });
    const details = renderer!.root.findByType("details");
    expect(details.props.open).toBeUndefined();
    const content = text(renderer!.toJSON());
    for (const expected of [
      "Work record",
      "Next stepAnimate the third",
      "Two avatars",
      "Keep CSS only.",
      "branch: feat/avatars",
      "Last result (completed)",
      "Two of four done.",
      "Do two more.",
    ]) {
      expect(content).toContain(expected);
    }
  });
});
