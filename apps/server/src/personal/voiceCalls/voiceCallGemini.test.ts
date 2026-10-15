// @effect-diagnostics preferSchemaOverJson:off - the point is the exact JSON body the mint sends.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { personalSecretPlaceholder, VOICE_CALL_SECRET_HEADER } from "@t3tools/contracts";

import {
  VOICE_CALL_MINT_URL,
  voiceCallBrokerRefusalCode,
  voiceCallMintErrorCode,
  voiceCallMintRequest,
  type VoiceCallMintOutcome,
} from "./voiceCallGemini.ts";

const outcome = (status: number, body: string): VoiceCallMintOutcome => ({
  status,
  token: null,
  body,
});

describe("voiceCallMintRequest", () => {
  it.effect("sends the key as the broker placeholder in x-goog-api-key, never in the URL", () =>
    Effect.sync(() => {
      const request = voiceCallMintRequest({
        expireTime: "2026-10-15T18:00:00.000Z",
        newSessionExpireTime: "2026-10-15T17:31:00.000Z",
      });
      expect(request.method).toBe("POST");
      expect(request.url).toBe(VOICE_CALL_MINT_URL);
      // The value never appears: the broker substitutes it, for this origin only.
      expect(request.headers?.[VOICE_CALL_SECRET_HEADER]).toBe(
        personalSecretPlaceholder("GEMINI_API_KEY"),
      );
      expect(request.url).not.toContain("{{");
      expect(JSON.stringify(request.body)).not.toContain("{{");
      expect(JSON.parse(request.body!)).toEqual({
        uses: 1,
        expireTime: "2026-10-15T18:00:00.000Z",
        newSessionExpireTime: "2026-10-15T17:31:00.000Z",
      });
    }),
  );
});

describe("voiceCallMintErrorCode", () => {
  it.effect("reads Google's answer as the code the call screen words", () =>
    Effect.sync(() => {
      expect(voiceCallMintErrorCode(outcome(401, "API key not valid"))).toBe("key_rejected");
      expect(voiceCallMintErrorCode(outcome(403, "PERMISSION_DENIED"))).toBe("key_rejected");
      expect(voiceCallMintErrorCode(outcome(429, "RESOURCE_EXHAUSTED"))).toBe("key_quota");
      expect(
        voiceCallMintErrorCode(outcome(400, "API key not valid. Please pass a valid API key.")),
      ).toBe("key_rejected");
      expect(voiceCallMintErrorCode(outcome(400, "bad request shape"))).toBe("google_unavailable");
      expect(voiceCallMintErrorCode(outcome(500, "internal"))).toBe("google_unavailable");
      expect(voiceCallMintErrorCode(outcome(503, "quota exceeded for now"))).toBe(
        "google_unavailable",
      );
      expect(voiceCallMintErrorCode(outcome(418, "quota"))).toBe("key_quota");
    }),
  );
});

describe("voiceCallBrokerRefusalCode", () => {
  it.effect("separates a missing key from an unusable one and from Google being down", () =>
    Effect.sync(() => {
      expect(
        voiceCallBrokerRefusalCode(
          "No saved key named GEMINI_API_KEY. Ask for it with request_secret.",
        ),
      ).toBe("no_key");
      expect(
        voiceCallBrokerRefusalCode(
          "GEMINI_API_KEY is saved as an environment variable, not as a brokered key, so it cannot be used here.",
        ),
      ).toBe("key_rejected");
      expect(
        voiceCallBrokerRefusalCode(
          "GEMINI_API_KEY is not allowed to be sent to https://generativelanguage.googleapis.com.",
        ),
      ).toBe("key_rejected");
      expect(voiceCallBrokerRefusalCode("The request timed out.")).toBe("google_unavailable");
    }),
  );
});
