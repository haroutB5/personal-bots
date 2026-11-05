import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { isEventRoutine, routineHookUrl, routineTriggerStatusLabel } from "./routineHook.ts";

const at = (iso: string) => DateTime.makeUnsafe(Date.parse(iso));

const scheduled = {
  enabled: true,
  schedule: { kind: "daily", time: "09:00" },
  eventLabel: null,
  lastFiredAt: null,
  nextDueAt: at("2026-09-15T08:00:00Z"),
  timeZone: "Europe/London",
} as const;

const event = {
  enabled: true,
  schedule: null,
  eventLabel: "PR merged",
  lastFiredAt: null,
  nextDueAt: null,
  timeZone: "Europe/London",
} as const;

describe("routineHookUrl", () => {
  it("hangs the token off the origin the page was served from", () => {
    expect(routineHookUrl("https://box.example.ts.net", "tok")).toBe(
      "https://box.example.ts.net/api/personal/hooks/tok",
    );
  });

  it("does not double the slash when the origin carries one", () => {
    expect(routineHookUrl("http://192.168.0.5:3000/", "tok")).toBe(
      "http://192.168.0.5:3000/api/personal/hooks/tok",
    );
  });
});

describe("routineTriggerStatusLabel", () => {
  it("shows a scheduled routine's next run", () => {
    expect(routineTriggerStatusLabel(scheduled)).toContain("Next:");
  });

  it("does not tell an event routine that it has no more runs", () => {
    expect(routineTriggerStatusLabel(event)).toBe("Waiting for its first event");
    expect(routineTriggerStatusLabel({ ...event, enabled: false })).toBe("Paused");
  });

  it("tells a scheduled routine apart from an event routine", () => {
    expect(isEventRoutine(event)).toBe(true);
    expect(isEventRoutine(scheduled)).toBe(false);
  });
});
