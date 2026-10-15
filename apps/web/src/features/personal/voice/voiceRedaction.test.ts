/**
 * What the voice is allowed to hear: the client's own belt and braces over the
 * server's redaction. Raw chat text must not reach Google on the browser's
 * account, and a long reply must not be read out in full.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_REDACTED,
  VOICE_SPOKEN_MAX_CHARS,
  containsRedactableSecret,
  redactForVoice,
} from "./voiceRedaction";

describe("redactForVoice", () => {
  it("hides a Gemini key", () => {
    expect(redactForVoice("the key is AIzaSyA1234567890abcdefghijklmnopq")).toBe(
      `the key is ${VOICE_REDACTED}`,
    );
  });

  it("hides the usual token shapes", () => {
    for (const text of [
      "sk-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_abcdefghijklmnopqrstuv",
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
      "Bearer abcdefghijklmnop",
    ]) {
      expect(redactForVoice(`here: ${text}`)).not.toContain(text);
    }
  });

  it("hides a value assigned to a secret-sounding name", () => {
    expect(redactForVoice("password: hunter2 and then some")).toBe(
      `password: ${VOICE_REDACTED} and then some`,
    );
    expect(redactForVoice("API_KEY = abcd1234")).toBe(`API_KEY = ${VOICE_REDACTED}`);
  });

  it("hides a card number and a long opaque blob", () => {
    expect(redactForVoice("card 4111 1111 1111 1111 ok")).toBe(`card ${VOICE_REDACTED} ok`);
    expect(redactForVoice("sig " + "a".repeat(48))).toBe(`sig ${VOICE_REDACTED}`);
  });

  it("leaves ordinary chat alone", () => {
    const text = "Deployed matchday 1.67.51 to Vercel and the gates are green.";
    expect(redactForVoice(text)).toBe(text);
    expect(containsRedactableSecret(text)).toBe(false);
  });

  it("caps how much the voice is ever handed", () => {
    const long = "word ".repeat(600);
    const capped = redactForVoice(long);
    expect(capped.length).toBeLessThanOrEqual(VOICE_SPOKEN_MAX_CHARS);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("reads null and undefined as nothing to say", () => {
    expect(redactForVoice(null)).toBe("");
    expect(redactForVoice(undefined)).toBe("");
  });
});
