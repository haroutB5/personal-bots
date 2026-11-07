import { describe, expect, it } from "vite-plus/test";

import { botSettingsRoutines, routinesForBot } from "./routinesModel.ts";

const routine = (routineId: string, botId: string, enabled = true) =>
  ({
    routineId,
    botId,
    title: routineId,
    enabled,
    schedule: null,
    eventLabel: "push",
    lastFiredAt: null,
    nextDueAt: null,
    timeZone: "Europe/London",
  }) as never;

describe("routinesForBot", () => {
  it("keeps this bot's routines in server order, at most three", () => {
    const rows = routinesForBot(
      [
        routine("r1", "b1"),
        routine("r2", "b2"),
        routine("r3", "b1"),
        routine("r4", "b1"),
        routine("r5", "b1"),
      ],
      "b1",
    );
    expect(rows.map((entry) => entry.routineId)).toEqual(["r1", "r3", "r4"]);
  });
});

describe("botSettingsRoutines", () => {
  it("puts enabled routines before paused ones", () => {
    const rows = botSettingsRoutines(
      [routine("r1", "b1", false), routine("r2", "b1", true), routine("r3", "b2", true)],
      "b1",
    );
    expect(rows.map((entry) => entry.routineId)).toEqual(["r2", "r1"]);
  });
});
