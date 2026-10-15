import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { VoiceCallContextMessage } from "@t3tools/contracts";

import {
  VOICE_CALL_INSTRUCTION_CONTEXT_CHARS,
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
