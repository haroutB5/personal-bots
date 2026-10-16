/**
 * Who can be called (Harout, 16 Oct 2026): "any team lead should have this
 * enabled for them. If it's a regular bot or agent then it doesn't get it."
 *
 * The bot's own team-lead flag is the only authority. The older per-bot
 * `allow_voice_calls` switch is still on the wire and in the database (for
 * rollback), and this test is what stops it creeping back as a decider.
 */
import { describe, expect, it } from "vite-plus/test";

import { botVoiceCallColour, botVoiceCallsEnabled } from "./botVoiceCalls";

describe("botVoiceCallsEnabled", () => {
  it("is true for a team lead, whatever the old switch says", () => {
    expect(botVoiceCallsEnabled({ lead: true })).toBe(true);
    expect(botVoiceCallsEnabled({ lead: true, allowVoiceCalls: false })).toBe(true);
    expect(botVoiceCallsEnabled({ lead: true, allowVoiceCalls: true })).toBe(true);
  });

  it("is false for a bot that is not a lead, whatever the old switch says", () => {
    expect(botVoiceCallsEnabled({ lead: false })).toBe(false);
    // The exact case Harout's rule is about: the old switch is on and the bot
    // is an ordinary agent.
    expect(botVoiceCallsEnabled({ lead: false, allowVoiceCalls: true })).toBe(false);
    expect(botVoiceCallsEnabled({})).toBe(false);
    expect(botVoiceCallsEnabled({ allowVoiceCalls: true })).toBe(false);
  });

  it("never throws on a half-built or missing bot", () => {
    expect(botVoiceCallsEnabled(undefined)).toBe(false);
    expect(botVoiceCallsEnabled(null)).toBe(false);
    expect(botVoiceCallsEnabled("CTO")).toBe(false);
  });
});

describe("botVoiceCallColour", () => {
  it("uses the bot's own colour and falls back to the app's neutral", () => {
    expect(botVoiceCallColour({ avatarColor: "#1A73E8" })).toBe("#1A73E8");
    expect(botVoiceCallColour({ avatarColor: "" })).toBe("#6f6f6b");
    expect(botVoiceCallColour(undefined)).toBe("#6f6f6b");
  });
});
