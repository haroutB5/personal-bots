import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  currentOrigin,
  isEventRoutine,
  routineHookUrl,
  routineTriggerStatusLabel,
} from "./routineHook";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("currentOrigin", () => {
  it("reads the served origin, which is the tunnel host when the phone is out", () => {
    vi.stubGlobal("window", { location: { origin: "https://box.example.ts.net" } });
    expect(currentOrigin()).toBe("https://box.example.ts.net");
  });

  it("returns null with no document rather than inventing an origin", () => {
    vi.stubGlobal("window", undefined);
    expect(currentOrigin()).toBeNull();
  });
});

describe("routineTriggerStatusLabel", () => {
  it("keeps the next run for a scheduled routine", () => {
    expect(routineTriggerStatusLabel(scheduled)).toMatch(/^Next: /);
    expect(isEventRoutine(scheduled)).toBe(false);
  });

  it("never tells an event routine it has no more runs", () => {
    // It has no nextDueAt, which for a scheduled routine means "No more runs" —
    // the opposite of the truth here.
    expect(routineTriggerStatusLabel(event)).toBe("Waiting for its first event");
    expect(isEventRoutine(event)).toBe(true);
  });

  it("shows when an event routine last fired", () => {
    expect(routineTriggerStatusLabel({ ...event, lastFiredAt: at("2026-09-14T10:05:00Z") })).toBe(
      "Last fired Mon 14 Sep, 11:05",
    );
  });

  it("reports a paused event routine as paused, not as waiting", () => {
    expect(routineTriggerStatusLabel({ ...event, enabled: false })).toBe("Paused");
  });
});
