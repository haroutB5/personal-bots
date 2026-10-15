import { describe, expect, it } from "vite-plus/test";

import {
  CURATED_VOICES,
  MORE_VOICES,
  VOICE_CALL_SECRET_NAME,
  hasVoiceCallKey,
  isVoiceCallErrorCode,
  voiceApiKeyCheckLine,
  voiceCallFailureCode,
  voiceCallKeySecret,
  voiceFailureDetail,
} from "./voiceCallApi";

describe("the error the server sent", () => {
  it("reads the contract's own code off a tagged error", () => {
    expect(voiceCallFailureCode({ _tag: "PersonalVoiceCallsError", code: "no_key" })).toBe(
      "no_key",
    );
    expect(voiceCallFailureCode({ code: "calls_not_allowed" })).toBe("calls_not_allowed");
    expect(voiceCallFailureCode({ error: { code: "key_quota" } })).toBe("key_quota");
    expect(voiceCallFailureCode({ cause: { error: { code: "rate_limited" } } })).toBe(
      "rate_limited",
    );
  });

  it("calls anything it cannot read a Google problem, which the owner can retry", () => {
    expect(voiceCallFailureCode(new Error("socket closed"))).toBe("google_unavailable");
    expect(voiceCallFailureCode(null)).toBe("google_unavailable");
    expect(voiceCallFailureCode({ code: "something_new" })).toBe("google_unavailable");
  });

  it("knows every code the contract lists, and nothing else", () => {
    for (const code of [
      "no_key",
      "key_rejected",
      "key_quota",
      "calls_not_allowed",
      "not_owner_chat",
      "google_unavailable",
      "rate_limited",
      "invalid_input",
      "not_found",
    ]) {
      expect(isVoiceCallErrorCode(code)).toBe(true);
    }
    expect(isVoiceCallErrorCode("nope")).toBe(false);
  });

  it("keeps the failure's own words short, never the whole object", () => {
    expect(voiceFailureDetail({ message: "Gemini said no" })).toBe("Gemini said no");
    expect(voiceFailureDetail({ message: "x".repeat(500) }).length).toBe(200);
    expect(voiceFailureDetail(undefined)).toBe("");
  });
});

describe("the settings row's key line", () => {
  it("maps each status to the same tones the DeepSeek row uses", () => {
    expect(voiceApiKeyCheckLine(null)).toEqual({ tone: "pending", text: "Checking this key…" });
    expect(voiceApiKeyCheckLine({ status: "ok", origin: "" })).toEqual({
      tone: "ok",
      text: "Key works",
    });
    expect(voiceApiKeyCheckLine({ status: "quota", origin: "" }).tone).toBe("empty");
    expect(voiceApiKeyCheckLine({ status: "rejected", origin: "" })).toEqual({
      tone: "rejected",
      text: "Google didn't accept this key",
    });
    // Neither of these is ever "your key is wrong".
    expect(voiceApiKeyCheckLine({ status: "missing", origin: "" }).tone).toBe("quiet");
    expect(voiceApiKeyCheckLine({ status: "unavailable", origin: "" })).toEqual({
      tone: "quiet",
      text: "Could not check the key right now",
    });
  });
});

describe("the saved Gemini key", () => {
  const secret = { name: VOICE_CALL_SECRET_NAME, label: "Gemini API key" } as never;

  it("is found by its contract name", () => {
    expect(hasVoiceCallKey([secret])).toBe(true);
    expect(hasVoiceCallKey([])).toBe(false);
    expect(hasVoiceCallKey(null)).toBe(false);
    expect(voiceCallKeySecret([{ name: "OTHER" } as never, secret])).toBe(secret);
  });
});

describe("the voice list", () => {
  it("offers eight curated voices and never repeats one behind More voices", () => {
    expect(CURATED_VOICES).toHaveLength(8);
    expect(CURATED_VOICES[0]).toEqual({ name: "Charon", note: "Informative · Default" });
    const curated = new Set(CURATED_VOICES.map((voice) => voice.name));
    expect(MORE_VOICES.length).toBeGreaterThan(0);
    expect(MORE_VOICES.some((name) => curated.has(name))).toBe(false);
  });
});
