import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { VoiceCallContextMessage } from "@t3tools/contracts";

import {
  VOICE_CALL_INSTRUCTION_CONTEXT_CHARS,
  VOICE_CALL_INSTRUCTION_RULES_CHARS,
  voiceCallSystemInstruction,
} from "./voiceCallInstructions.ts";

const at = DateTime.makeUnsafe("2026-10-15T17:00:00.000Z");
const message = (role: "user" | "bot", text: string): VoiceCallContextMessage => ({
  role,
  text,
  at,
});

const base = {
  botName: "CTO",
  botTitle: "Chief technology officer",
  botDescription: "Plans, prioritises and reports.",
  botInstructions: "Talk plainly, outcome first, no filler. Never ship without a gate.",
  preferences: ["Lead with the outcome."] as ReadonlyArray<string>,
  displayName: "Harout",
  statusLabel: "Idle",
  statusDetail: "",
  recentMessages: [] as ReadonlyArray<VoiceCallContextMessage>,
  callouts: [] as ReadonlyArray<string>,
  voiceName: "Charon",
};

describe("voiceCallSystemInstruction", () => {
  it.effect("speaks as the bot itself, in the first person", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction(base);
      expect(text).toContain("You ARE CTO (Chief technology officer)");
      expect(text).toContain("speaking in the first person");
      // The relayed wording is named as the wrong thing to say.
      expect(text).toContain('never "I\'ve sent that to CTO"');
    }),
  );

  it.effect("carries the bot's own saved personality and the owner's rules", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction(base);
      expect(text).toContain("Who you are");
      expect(text).toContain("Plans, prioritises and reports.");
      expect(text).toContain("Never ship without a gate.");
      expect(text).toContain("Standing rules Harout has saved for you");
      expect(text).toContain("- Lead with the outcome.");
    }),
  );

  it.effect(
    "routes public facts to Google Search, own facts to lookup_memory, work to the bot",
    () =>
      Effect.sync(() => {
        const text = voiceCallSystemInstruction(base).replace(/\s+/g, " ");
        expect(text).toContain("built-in Google Search");
        expect(text).toContain("weather, news, sport, opening times");
        expect(text).toContain("Use lookup_memory for anything about the owner's own life");
        expect(text).toContain("Use the real bot only for real work");
      }),
  );

  it.effect("drops the personality and rules blocks when the bot has none", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction({
        ...base,
        botDescription: "",
        botInstructions: "",
        preferences: [],
      });
      expect(text).not.toContain("Who you are");
      expect(text).not.toContain("Standing rules");
      // The honesty rule is never optional.
      expect(text).toContain("Report only what the chat and the status below actually say");
    }),
  );

  it.effect("never lets the rules block run away", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction({
        ...base,
        preferences: Array.from({ length: 200 }, (_, index) => `rule ${index} ${"y".repeat(60)}`),
      });
      const start = text.indexOf("Standing rules");
      const end = text.indexOf("How you talk:");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const rules = text.slice(start, end);
      expect(rules.length).toBeLessThanOrEqual(VOICE_CALL_INSTRUCTION_RULES_CHARS + 120);
      expect(rules).toContain("rule 0");
      // The cap drops the tail rather than truncating a rule mid-sentence.
      expect(rules).not.toContain("rule 199");
    }),
  );

  it.effect("carries the honesty rule and the send rule", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction(base);
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain("Report only what the chat and the status below actually say");
      expect(flat).toContain("Never invent work");
      expect(flat).toContain("the app posts your words into the chat");
    }),
  );

  it.effect("names the status, the step and the waiting cards, never their contents", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction({
        ...base,
        statusLabel: "Waiting on you",
        statusDetail: "Running the gates",
        callouts: ["a login for vercel.com", "a secret called GITHUB_TOKEN"],
      });
      expect(text).toContain("Right now: Waiting on you.");
      expect(text).toContain("Latest step: Running the gates");
      expect(text).toContain("a login for vercel.com");
      expect(text).toContain("a secret called GITHUB_TOKEN");
    }),
  );

  it.effect("gives the chat context oldest first and never more than the cap", () =>
    Effect.sync(() => {
      const long = "x".repeat(400);
      const messages = Array.from({ length: 30 }, (_, index) =>
        message(index % 2 === 0 ? "user" : "bot", `line ${index} ${long}`),
      );
      const text = voiceCallSystemInstruction({ ...base, recentMessages: messages });
      const context = text.slice(text.indexOf("The last messages in this chat"));
      expect(context.length).toBeLessThanOrEqual(VOICE_CALL_INSTRUCTION_CONTEXT_CHARS + 200);
      // The newest line survives; the oldest are the ones dropped.
      expect(context).toContain("line 29");
      expect(context).not.toContain("line 0 ");
    }),
  );

  it.effect("falls back to 'the owner' when no display name is set", () =>
    Effect.sync(() => {
      const text = voiceCallSystemInstruction({ ...base, displayName: "" });
      expect(text).toContain("live phone call with the owner");
    }),
  );
});
