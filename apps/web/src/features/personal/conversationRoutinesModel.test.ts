import type { PersonalRoutine } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { routinesForBot } from "./conversationRoutinesModel";

const routine = (routineId: string, botId: string) =>
  ({ routineId, botId, title: routineId }) as PersonalRoutine;

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
