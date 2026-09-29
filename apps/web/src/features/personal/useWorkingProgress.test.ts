import { describe, expect, it } from "vite-plus/test";

import {
  PROGRESS_REFRESH_MS,
  currentProgressNote,
  currentTurnHasToolStep,
  progressRefreshDelayMs,
} from "./useWorkingProgress";

describe("progressRefreshDelayMs", () => {
  it("reads at once the first time, and holds later reads to one per interval", () => {
    expect(progressRefreshDelayMs(0, 1_000_000)).toBe(0);
    expect(progressRefreshDelayMs(1_000_000, 1_000_000)).toBe(PROGRESS_REFRESH_MS);
    expect(progressRefreshDelayMs(1_000_000, 1_001_000)).toBe(PROGRESS_REFRESH_MS - 1_000);
    expect(progressRefreshDelayMs(1_000_000, 1_000_000 + PROGRESS_REFRESH_MS + 1)).toBe(0);
  });
});

describe("currentProgressNote", () => {
  const entry = { note: "MCP tool call", turnId: "turn-1" };

  it("shows a note only from the turn the shell reports as its latest", () => {
    expect(currentProgressNote(entry, { latestTurn: { turnId: "turn-1" } })).toBe("MCP tool call");
    // The next turn started; the cached note is the previous turn's.
    expect(currentProgressNote(entry, { latestTurn: { turnId: "turn-2" } })).toBeUndefined();
    // A turn is not on the shell yet (starting), but the note names one.
    expect(currentProgressNote(entry, { latestTurn: null })).toBeUndefined();
    expect(currentProgressNote(entry, {})).toBeUndefined();
  });

  it("matches a note and a shell that both name no turn yet", () => {
    expect(currentProgressNote({ note: "Planning", turnId: null }, { latestTurn: null })).toBe(
      "Planning",
    );
    expect(
      currentProgressNote({ note: "Planning", turnId: null }, { latestTurn: { turnId: "turn-9" } }),
    ).toBeUndefined();
  });

  it("has nothing to show without a note", () => {
    expect(currentProgressNote(undefined, { latestTurn: { turnId: "turn-1" } })).toBeUndefined();
  });
});

describe("currentTurnHasToolStep", () => {
  it("is true only for a tool step read from the shell's latest turn", () => {
    const entry = { note: "Command run", turnId: "turn-1", toolStep: true };
    expect(currentTurnHasToolStep(entry, { latestTurn: { turnId: "turn-1" } })).toBe(true);
    expect(currentTurnHasToolStep(entry, { latestTurn: { turnId: "turn-2" } })).toBe(false);
    expect(currentTurnHasToolStep(entry, { latestTurn: null })).toBe(false);
  });

  it("is false for thinking-only notes, an older server's notes and no note", () => {
    const shell = { latestTurn: { turnId: "turn-1" } };
    expect(
      currentTurnHasToolStep({ note: "Planning", turnId: "turn-1", toolStep: false }, shell),
    ).toBe(false);
    expect(currentTurnHasToolStep({ note: "Planning", turnId: "turn-1" }, shell)).toBe(false);
    expect(currentTurnHasToolStep(undefined, shell)).toBe(false);
  });
});
