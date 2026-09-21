import { describe, expect, it } from "@effect/vitest";

import { buildCatchUpBrief, buildCatchUpTranscript } from "./groupTurnText.ts";

const line = (speaker: string, text: string) => ({ speaker, text });

describe("buildCatchUpTranscript", () => {
  it("keeps everything when it fits", () => {
    expect(
      buildCatchUpTranscript({
        messages: [line("You", "hello"), line("Dev", "hi")],
        maxChars: 1_000,
      }),
    ).toBe("You: hello\n\nDev: hi");
  });

  it("keeps the newest lines and collapses the rest into one notice", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      line("You", `message ${String(index)}`),
    );
    // Room for roughly two lines: the older eight collapse.
    const transcript = buildCatchUpTranscript({ messages, maxChars: 40 });
    expect(transcript).toContain("[… 8 earlier messages omitted]");
    expect(transcript).toContain("message 9");
    expect(transcript).not.toContain("message 0");
    expect(transcript.length).toBeLessThan(80);
  });

  it("singularises the notice", () => {
    expect(
      buildCatchUpTranscript({
        messages: [line("You", "0123456789"), line("You", "abcdefghij")],
        maxChars: 16,
      }),
    ).toContain("[… 1 earlier message omitted]");
  });

  it("tail-truncates a single message that overflows the whole budget", () => {
    // Never nothing: the member has to see what it was just asked.
    const transcript = buildCatchUpTranscript({
      messages: [line("You", "x".repeat(200))],
      maxChars: 20,
    });
    expect(transcript).toContain("[… truncated]");
    expect(transcript).toContain("xxxx");
    expect(transcript.length).toBeLessThan(50);
  });

  it("is empty when there is nothing new", () => {
    expect(buildCatchUpTranscript({ messages: [], maxChars: 100 })).toBe("");
  });
});

describe("buildCatchUpBrief", () => {
  it("names the group, the speaker and the mention vocabulary", () => {
    const brief = buildCatchUpBrief({
      groupName: "Launch crew",
      speakerName: "Dev",
      otherNames: ["Assistant", "Planner"],
      messages: [line("You", "ship it")],
      maxChars: 1_000,
    });
    expect(brief).toContain("[Group chat: Launch crew]");
    expect(brief).toContain("You are Dev in this group.");
    // A member's provider sees only its own thread, so the @ names it may use
    // have to be in the brief or it cannot route to anyone.
    expect(brief).toContain("@Assistant");
    expect(brief).toContain("@Planner");
    expect(brief).toContain("You: ship it");
  });

  it("says so when nobody else is left", () => {
    const brief = buildCatchUpBrief({
      groupName: "Solo",
      speakerName: "Dev",
      otherNames: [],
      messages: [],
      maxChars: 1_000,
    });
    expect(brief).toContain("You are the only member.");
  });

  it("has the verdict speak for the group, not for its writer", () => {
    const brief = buildCatchUpBrief({
      groupName: "Lunas",
      speakerName: "Luna1",
      otherNames: ["Luna2"],
      messages: [],
      maxChars: 1_000,
      phase: "verdict",
    });
    expect(brief).toContain("first person plural");
    expect(brief).toContain("never as yourself");
  });
});
