import { describe, expect, it } from "@effect/vitest";

import { PersonalBotId } from "@t3tools/contracts";

import { maskCode, parseMentions } from "./groupMentions.ts";

const bot = (key: string) => PersonalBotId.make(`bot-${key}`);

const CANDIDATES = [
  { botId: bot("assistant"), name: "Assistant" },
  { botId: bot("dev"), name: "Dev" },
  { botId: bot("devops"), name: "Dev Ops" },
  { botId: bot("planner"), name: "Planner" },
];

describe("parseMentions", () => {
  it("takes the longest matching name, case-insensitively", () => {
    expect(parseMentions("@Dev Ops please look, then @dev can build it", CANDIDATES)).toEqual([
      bot("devops"),
      bot("dev"),
    ]);
  });

  it("keeps mention order and de-duplicates", () => {
    expect(parseMentions("@Planner @Dev @Planner again", CANDIDATES)).toEqual([
      bot("planner"),
      bot("dev"),
    ]);
  });

  it("expands @all and @everyone in sort order", () => {
    expect(parseMentions("@all what do you think?", CANDIDATES)).toEqual(
      CANDIDATES.map((candidate) => candidate.botId),
    );
    expect(parseMentions("ok @everyone", CANDIDATES)).toEqual(
      CANDIDATES.map((candidate) => candidate.botId),
    );
  });

  it("ignores mentions inside fenced blocks and inline code", () => {
    const text = [
      "Run this:",
      "```sh",
      "echo '@Planner ping'",
      "```",
      "and note that `@Dev` is only a label.",
      "But @Assistant should actually reply.",
    ].join("\n");
    // The cost rail: a pasted snippet must not buy anyone a provider turn.
    expect(parseMentions(text, CANDIDATES)).toEqual([bot("assistant")]);
  });

  it("does not read an email address as a mention", () => {
    expect(parseMentions("mail me at harout@dev.example", CANDIDATES)).toEqual([]);
  });

  it("requires a word boundary after the name", () => {
    expect(parseMentions("@Development is not @Dev", CANDIDATES)).toEqual([bot("dev")]);
  });

  it("finds nothing when no name matches", () => {
    expect(parseMentions("@Nobody at all here", CANDIDATES)).toEqual([]);
  });
});

describe("maskCode", () => {
  it("keeps every index stable so positions still line up", () => {
    const text = "a `code` b\n```\nfence\n```\nc";
    const masked = maskCode(text);
    expect(masked.length).toBe(text.length);
    expect(masked.split("\n").map((line) => line.length)).toEqual(
      text.split("\n").map((line) => line.length),
    );
    expect(masked).toContain("a        b");
  });

  it("leaves an unclosed inline span alone rather than eating the rest", () => {
    expect(maskCode("half `open @Dev")).toBe("half `open @Dev");
  });
});
