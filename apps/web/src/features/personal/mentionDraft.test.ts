import { describe, expect, it } from "vite-plus/test";

import {
  activeMentionDraft,
  applyMention,
  matchMentionCandidates,
  MENTION_SUGGESTION_LIMIT,
} from "./mentionDraft";

const members = [
  { botId: "b-ada", name: "Ada" },
  { botId: "b-grace", name: "Grace" },
  { botId: "b-chief", name: "Chief of Staff" },
  { botId: "b-adrian", name: "Adrian" },
];

describe("activeMentionDraft", () => {
  it("finds the token being typed and the range it occupies", () => {
    const text = "what do you think @gra";
    expect(activeMentionDraft(text, text.length)).toEqual({
      query: "gra",
      start: 18,
      end: text.length,
    });
  });

  it("opens on a bare @ so the whole roster is offered", () => {
    expect(activeMentionDraft("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("keeps the token open across a space so multi-word names complete", () => {
    const text = "@Chief of";
    expect(activeMentionDraft(text, text.length)?.query).toBe("Chief of");
  });

  it("ignores an @ that does not open a word", () => {
    // An email address, and the arithmetic sense of "@".
    expect(activeMentionDraft("mail me at ada@example.com", 26)).toBeNull();
  });

  it("closes once the caret leaves the token", () => {
    const text = "@Ada said so";
    // Caret parked before the @: nothing is being typed there.
    expect(activeMentionDraft(text, 0)).toBeNull();
  });

  it("closes on a newline and on a sentence that merely contains an @", () => {
    expect(activeMentionDraft("@Ada\nnext line", 14)).toBeNull();
    expect(activeMentionDraft("meet @ 5pm", 10)).toBeNull();
    const long = `@${"x".repeat(41)}`;
    expect(activeMentionDraft(long, long.length)).toBeNull();
  });

  it("clamps a caret outside the text instead of throwing", () => {
    expect(activeMentionDraft("@Ad", 999)?.query).toBe("Ad");
  });
});

describe("matchMentionCandidates", () => {
  it("puts prefix matches before contained ones, then sorts by name", () => {
    expect(matchMentionCandidates(members, "a").map((entry) => entry.name)).toEqual([
      "Ada",
      "Adrian",
      "Chief of Staff",
      "Grace",
    ]);
  });

  it("is case-insensitive and matches inside a multi-word name", () => {
    expect(matchMentionCandidates(members, "staff").map((entry) => entry.name)).toEqual([
      "Chief of Staff",
    ]);
  });

  it("offers everyone for an empty query, capped at the member cap", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      botId: `b-${index}`,
      name: `Bot ${index}`,
    }));
    expect(matchMentionCandidates(many, "")).toHaveLength(MENTION_SUGGESTION_LIMIT);
  });

  it("returns nothing when no member matches", () => {
    expect(matchMentionCandidates(members, "zzz")).toEqual([]);
  });
});

describe("applyMention", () => {
  it("replaces the token with '@Name ' and parks the caret after it", () => {
    const text = "what do you think @gra";
    const draft = activeMentionDraft(text, text.length)!;
    expect(applyMention(text, draft, "Grace")).toEqual({
      text: "what do you think @Grace ",
      caret: 25,
    });
  });

  it("keeps the rest of the line and does not double an existing space", () => {
    const text = "@ad about the migration";
    const draft = activeMentionDraft(text, 3)!;
    expect(applyMention(text, draft, "Ada")).toEqual({
      text: "@Ada about the migration",
      caret: 5,
    });
  });
});
