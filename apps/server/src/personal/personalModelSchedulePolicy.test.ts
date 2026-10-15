import {
  PERSONAL_FALLBACK_REASON_SCHEDULE,
  type ModelSelection,
  type PersonalBotSchedule,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  formatTimeOfDay,
  isScheduleFallback,
  localClockAt,
  modelScheduleEnabledByEnv,
  parseTimeOfDay,
  scheduleProblem,
  scheduleState,
  scheduleWindowOf,
  wallTimeToEpochMs,
  windowEndMs,
  windowOpenAtMinute,
} from "./personalModelSchedulePolicy.ts";

const LONDON = "Europe/London";
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const HOME: ModelSelection = { instanceId: CLAUDE, model: "claude-opus-5-5" };
const SONNET: ModelSelection = {
  instanceId: CLAUDE,
  model: "claude-sonnet-5-5",
  options: [{ id: "effort", value: "high" }],
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (text: string) => Date.parse(text);

const schedule = (patch: Partial<PersonalBotSchedule> = {}): PersonalBotSchedule => ({
  enabled: true,
  from: "22:00",
  to: "07:00",
  modelSelection: SONNET,
  ...patch,
});

describe("time of day", () => {
  it("parses 24 h HH:MM and refuses everything else", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("22:45")).toBe(22 * 60 + 45);
    expect(parseTimeOfDay("23:59")).toBe(23 * 60 + 59);
    for (const bad of ["24:00", "7:00", "07:60", "07:00pm", "", "0700", "07:0"]) {
      expect(parseTimeOfDay(bad)).toBeNull();
    }
    expect(formatTimeOfDay(7 * 60 + 5)).toBe("07:05");
  });
});

describe("window open and close", () => {
  const overnight = scheduleWindowOf({ from: "22:00", to: "07:00" })!;
  const daytime = scheduleWindowOf({ from: "09:00", to: "17:30" })!;

  it("refuses From = To and malformed times", () => {
    expect(scheduleWindowOf({ from: "10:00", to: "10:00" })).toBeNull();
    expect(scheduleWindowOf({ from: "10:00", to: "25:00" })).toBeNull();
  });

  it("a same-day window is open from its start up to, not including, its end", () => {
    expect(windowOpenAtMinute(daytime, 9 * 60 - 1)).toBe(false);
    expect(windowOpenAtMinute(daytime, 9 * 60)).toBe(true);
    expect(windowOpenAtMinute(daytime, 17 * 60 + 29)).toBe(true);
    expect(windowOpenAtMinute(daytime, 17 * 60 + 30)).toBe(false);
  });

  it("an overnight window is open in the evening and the early morning", () => {
    expect(windowOpenAtMinute(overnight, 21 * 60 + 59)).toBe(false);
    expect(windowOpenAtMinute(overnight, 22 * 60)).toBe(true);
    expect(windowOpenAtMinute(overnight, 23 * 60 + 59)).toBe(true);
    expect(windowOpenAtMinute(overnight, 0)).toBe(true);
    expect(windowOpenAtMinute(overnight, 6 * 60 + 59)).toBe(true);
    expect(windowOpenAtMinute(overnight, 7 * 60)).toBe(false);
    expect(windowOpenAtMinute(overnight, 12 * 60)).toBe(false);
  });

  it("the end of an overnight window is tomorrow's To in the evening and today's in the morning", () => {
    // 23:00 BST on Thursday 15 Oct (22:00Z): ends Friday 07:00 BST = 06:00Z.
    const evening = windowEndMs(overnight, at("2026-10-15T22:00:00Z"), LONDON);
    expect(evening === null ? null : iso(evening)).toBe("2026-10-16T06:00:00.000Z");
    // 03:30 BST on Friday 16 Oct: ends the same morning, 07:00 BST = 06:00Z.
    const morning = windowEndMs(overnight, at("2026-10-16T02:30:00Z"), LONDON);
    expect(morning === null ? null : iso(morning)).toBe("2026-10-16T06:00:00.000Z");
    // Outside the window: no end.
    expect(windowEndMs(overnight, at("2026-10-15T12:00:00Z"), LONDON)).toBeNull();
  });

  it("a same-day window ends today", () => {
    const end = windowEndMs(daytime, at("2026-10-15T08:15:00Z"), LONDON); // 09:15 BST
    expect(end === null ? null : iso(end)).toBe("2026-10-15T16:30:00.000Z"); // 17:30 BST
  });

  it("reads the wall clock of the zone, in winter and summer time", () => {
    expect(localClockAt(at("2026-07-01T22:30:00Z"), LONDON).minuteOfDay).toBe(23 * 60 + 30);
    expect(localClockAt(at("2026-01-01T22:30:00Z"), LONDON).minuteOfDay).toBe(22 * 60 + 30);
    expect(wallTimeToEpochMs(2026, 7, 1, 7 * 60, LONDON)).toBe(at("2026-07-01T06:00:00Z"));
    expect(wallTimeToEpochMs(2026, 1, 1, 7 * 60, LONDON)).toBe(at("2026-01-01T07:00:00Z"));
  });

  it("a night the clocks go back (25 Oct 2026) is 25 hours long and still ends at 07:00 local", () => {
    // 22:00 BST on Saturday 24 Oct = 21:00Z; the clocks go back at 02:00 BST (01:00Z).
    const open = at("2026-10-24T21:00:00Z");
    expect(windowOpenAtMinute(overnight, localClockAt(open, LONDON).minuteOfDay)).toBe(true);
    const end = windowEndMs(overnight, open, LONDON);
    // 07:00 GMT on Sunday 25 Oct = 07:00Z.
    expect(end === null ? null : iso(end)).toBe("2026-10-25T07:00:00.000Z");
    // 06:30Z is 06:30 GMT: still open; 07:00Z is closed.
    expect(
      windowOpenAtMinute(overnight, localClockAt(at("2026-10-25T06:30:00Z"), LONDON).minuteOfDay),
    ).toBe(true);
    expect(
      windowOpenAtMinute(overnight, localClockAt(at("2026-10-25T07:00:00Z"), LONDON).minuteOfDay),
    ).toBe(false);
  });

  it("a night the clocks go forward (28 Mar 2027) is 23 hours long and ends at 07:00 local", () => {
    // 22:00 GMT on Saturday 27 Mar 2027 = 22:00Z; the clocks go forward at 01:00 GMT.
    const open = at("2027-03-27T22:00:00Z");
    const end = windowEndMs(overnight, open, LONDON);
    // 07:00 BST on Sunday 28 Mar = 06:00Z.
    expect(end === null ? null : iso(end)).toBe("2027-03-28T06:00:00.000Z");
  });

  it("a time that does not exist (01:30 on 28 Mar 2027) resolves after the gap, not before it", () => {
    const resolved = wallTimeToEpochMs(2027, 3, 28, 90, LONDON);
    expect(resolved).toBeGreaterThanOrEqual(at("2027-03-28T01:00:00Z"));
    expect(resolved).toBeLessThanOrEqual(at("2027-03-28T02:00:00Z"));
  });
});

describe("scheduleState", () => {
  const base = {
    atMs: at("2026-10-15T22:30:00Z"), // 23:30 BST
    timeZone: LONDON,
    killSwitchOn: true,
    schedule: schedule(),
    home: HOME,
  };

  it("is open inside the window with the model and the end", () => {
    const state = scheduleState(base);
    expect(state.kind).toBe("open");
    if (state.kind !== "open") return;
    expect(state.selection).toEqual(SONNET);
    expect(iso(state.untilMs)).toBe("2026-10-16T06:00:00.000Z");
  });

  it("is closed outside the window", () => {
    expect(scheduleState({ ...base, atMs: at("2026-10-15T12:00:00Z") })).toEqual({
      kind: "closed",
      reason: "outside",
    });
  });

  it("is closed with the kill switch off, no schedule, a disabled one, From = To, or the bot's own model", () => {
    expect(scheduleState({ ...base, killSwitchOn: false })).toEqual({
      kind: "closed",
      reason: "kill_switch",
    });
    expect(scheduleState({ ...base, schedule: undefined })).toEqual({
      kind: "closed",
      reason: "no_schedule",
    });
    expect(scheduleState({ ...base, schedule: schedule({ enabled: false }) })).toEqual({
      kind: "closed",
      reason: "disabled",
    });
    expect(scheduleState({ ...base, schedule: schedule({ from: "08:00", to: "08:00" }) })).toEqual({
      kind: "closed",
      reason: "invalid_range",
    });
    expect(scheduleState({ ...base, home: SONNET })).toEqual({
      kind: "closed",
      reason: "same_model",
    });
  });

  it("only a different context window is still the bot's own model", () => {
    const bigWindow: ModelSelection = {
      ...SONNET,
      options: [...(SONNET.options ?? []), { id: "contextWindow", value: "1m" }],
    };
    expect(
      scheduleState({ ...base, home: SONNET, schedule: schedule({ modelSelection: bigWindow }) }),
    ).toEqual({
      kind: "closed",
      reason: "same_model",
    });
  });

  it("the same model at a different effort is a real schedule", () => {
    const lowSonnet: ModelSelection = { ...SONNET, options: [{ id: "effort", value: "low" }] };
    expect(scheduleState({ ...base, home: lowSonnet }).kind).toBe("open");
  });
});

describe("kill switch and reason", () => {
  it("reads PERSONAL_MODEL_SCHEDULE", () => {
    expect(modelScheduleEnabledByEnv(undefined)).toBe(true);
    expect(modelScheduleEnabledByEnv("on")).toBe(true);
    for (const off of ["off", "OFF", "0", "false", "no", "disabled", " off "]) {
      expect(modelScheduleEnabledByEnv(off)).toBe(false);
    }
  });

  it("tells its own fallback row from the others", () => {
    expect(isScheduleFallback({ reason: PERSONAL_FALLBACK_REASON_SCHEDULE })).toBe(true);
    expect(isScheduleFallback({ reason: "deepseek_peak" })).toBe(false);
    expect(isScheduleFallback({ reason: null })).toBe(false);
  });
});

describe("scheduleProblem", () => {
  it("refuses From = To, a bad time and the bot's own model, in plain words", () => {
    expect(scheduleProblem({ from: "10:00", to: "10:00", modelSelection: SONNET }, HOME)).toBe(
      "From and To can't be the same time.",
    );
    expect(scheduleProblem({ from: "7:00", to: "10:00", modelSelection: SONNET }, HOME)).toBe(
      "Times are 24 hour, like 22:00.",
    );
    expect(scheduleProblem({ from: "22:00", to: "07:00", modelSelection: HOME }, HOME)).toBe(
      "Pick a different model from the bot's own.",
    );
    expect(
      scheduleProblem({ from: "22:00", to: "07:00", modelSelection: SONNET }, HOME),
    ).toBeNull();
  });
});
