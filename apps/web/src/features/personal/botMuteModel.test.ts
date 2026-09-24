import { describe, expect, it } from "vite-plus/test";

import {
  botMuteState,
  initialNotificationsChoice,
  mutedUntilLabel,
  muteForChoice,
} from "./botMuteModel";

const INDEFINITE = "9999-12-31T23:59:59.000Z";
// Local wall-clock times, so the labels hold in any test time zone.
const now = new Date(2026, 8, 24, 14, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).toISOString();

describe("botMuteState", () => {
  it("is on with no mute, and on again once a timed mute has run out", () => {
    expect(botMuteState({ notificationsMutedUntil: null }, now)).toEqual({ muted: false });
    expect(botMuteState({}, now)).toEqual({ muted: false });
    expect(botMuteState({ notificationsMutedUntil: at(24, 13, 59) }, now)).toEqual({
      muted: false,
    });
  });

  it("is muted while a timed mute is ahead, and indefinitely for the far-future time", () => {
    expect(botMuteState({ notificationsMutedUntil: at(24, 15) }, now)).toEqual({
      muted: true,
      indefinite: false,
      untilMs: Date.parse(at(24, 15)),
    });
    expect(botMuteState({ notificationsMutedUntil: INDEFINITE }, now)).toMatchObject({
      muted: true,
      indefinite: true,
    });
  });
});

describe("mutedUntilLabel", () => {
  const label = (until: string) => {
    const state = botMuteState({ notificationsMutedUntil: until }, now);
    if (!state.muted) throw new Error("expected a mute");
    return mutedUntilLabel(state, now, "en-GB");
  };

  it("names the time today, tomorrow, or the weekday after that", () => {
    expect(label(at(24, 15, 0))).toBe("Muted until 15:00");
    expect(label(at(25, 1, 10))).toBe("Muted until tomorrow, 1:10");
    expect(label(at(27, 9, 30))).toBe("Muted until Sun, 9:30");
    expect(label(INDEFINITE)).toBe("Muted until you turn it back on");
  });
});

describe("the bot editor's Notifications select", () => {
  it("starts on the bot's own state", () => {
    expect(initialNotificationsChoice(null, now)).toBe("on");
    expect(initialNotificationsChoice({ notificationsMutedUntil: null }, now)).toBe("on");
    expect(initialNotificationsChoice({ notificationsMutedUntil: INDEFINITE }, now)).toBe("keep");
  });

  it("sends nothing when unchanged, so other edits never restart a mute", () => {
    expect(muteForChoice("keep", "keep")).toBeUndefined();
    expect(muteForChoice("on", "on")).toBeUndefined();
    expect(muteForChoice("on", "keep")).toBe("on");
    expect(muteForChoice("1h", "on")).toEqual({ forMinutes: 60 });
    expect(muteForChoice("8h", "keep")).toEqual({ forMinutes: 480 });
    expect(muteForChoice("indefinitely", "on")).toBe("indefinitely");
  });
});
