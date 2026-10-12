import { describe, expect, it } from "vite-plus/test";

import { teamBotCaption, type TeamCaptionInput } from "./teamCaption";

const input = (patch: Partial<TeamCaptionInput>): TeamCaptionInput => ({
  status: { label: "Ready", tone: "normal" },
  live: false,
  thinking: false,
  modelLabel: "Sonnet 5.5 · H",
  progressNote: null,
  ...patch,
});

describe("teamBotCaption", () => {
  it("shows the model and effort when the bot is idle", () => {
    expect(teamBotCaption(input({}))).toEqual({ text: "Sonnet 5.5 · H", tone: "idle" });
  });

  it("shows the state word in amber for anything that wants the owner", () => {
    for (const label of [
      "Needs approval",
      "Needs your reply",
      "Needs a secret",
      "Needs your help",
    ]) {
      expect(teamBotCaption(input({ status: { label, tone: "review" } }))).toEqual({
        text: label,
        tone: "needs",
      });
    }
    // A broken provider is the app's own "tap to fix" state, review-toned there too.
    expect(
      teamBotCaption(input({ status: { label: "Update broke Claude Code", tone: "review" } })).tone,
    ).toBe("needs");
  });

  it("shows the current step in green while the bot works", () => {
    expect(teamBotCaption(input({ live: true, progressNote: "Planning release 2.4" }))).toEqual({
      text: "Planning release 2.4",
      tone: "working",
    });
    // No note yet: the plain word, never an empty line.
    expect(teamBotCaption(input({ live: true }))).toEqual({ text: "Working", tone: "working" });
  });

  it("says Thinking, in grey, while a live turn has said nothing yet", () => {
    expect(teamBotCaption(input({ live: true, thinking: true }))).toEqual({
      text: "Thinking",
      tone: "thinking",
    });
    // A note read from the previous turn does not outrank thinking.
    expect(
      teamBotCaption(input({ live: true, thinking: true, progressNote: "Old step" })).text,
    ).toBe("Thinking");
  });

  it("keeps a waiting or unavailable state in words when there is no model to name", () => {
    expect(
      teamBotCaption(
        input({ status: { label: "Waiting on Developer", tone: "waiting" }, modelLabel: null }),
      ),
    ).toEqual({ text: "Waiting on Developer", tone: "idle" });
    expect(teamBotCaption(input({ modelLabel: null }))).toEqual({ text: "Ready", tone: "idle" });
  });
});
