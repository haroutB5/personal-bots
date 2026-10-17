import type { PersonalRoutine } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botSettingsRoutines, routinesForBot } from "./conversationRoutinesModel";

const routine = (routineId: string, botId: string, enabled = true) =>
  ({ routineId, botId, title: routineId, enabled }) as PersonalRoutine;

describe("routinesForBot", () => {
  it("keeps server order, filters to the current bot, and caps the preview at three", () => {
    const routines = [
      routine("one", "bot-a"),
      routine("other", "bot-b"),
      routine("two", "bot-a"),
      routine("three", "bot-a"),
      routine("four", "bot-a"),
    ];
    expect(routinesForBot(routines, "bot-a").map((entry) => entry.routineId)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(routinesForBot(routines, "missing")).toEqual([]);
  });
});

describe("botSettingsRoutines", () => {
  it("lists only this bot's routines, enabled first and server order within each group", () => {
    const routines = [
      routine("paused-first", "bot-a", false),
      routine("other", "bot-b"),
      routine("enabled-one", "bot-a"),
      routine("paused-second", "bot-a", false),
      routine("enabled-two", "bot-a"),
    ];
    expect(botSettingsRoutines(routines, "bot-a").map((entry) => entry.routineId)).toEqual([
      "enabled-one",
      "enabled-two",
      "paused-first",
      "paused-second",
    ]);
  });

  it("returns nothing for a bot with no routines", () => {
    expect(botSettingsRoutines([routine("one", "bot-a")], "bot-b")).toEqual([]);
    expect(botSettingsRoutines([], "bot-a")).toEqual([]);
  });
});
