/**
 * The call marker: which chat messages the voice sent during a call, and the
 * tag that tells them apart from typed ones.
 */
import { describe, expect, it } from "vite-plus/test";

import { PERSONAL_VOICE_CALL_CONTEXT_KIND } from "@t3tools/contracts";

import { readVoiceCallMarker, VOICE_CALL_TAG_LABEL } from "./voiceCallMessage";

const marker = (payload: unknown) =>
  ({
    records: [{ kind: PERSONAL_VOICE_CALL_CONTEXT_KIND, payload }],
  }) as never;

describe("readVoiceCallMarker", () => {
  it("reads the call a message came from", () => {
    expect(readVoiceCallMarker(marker({ callId: "call-1", source: "voice_call" }))).toEqual({
      callId: "call-1",
      source: "voice_call",
    });
  });

  it("is null for a typed message", () => {
    expect(readVoiceCallMarker(undefined)).toBeNull();
    expect(readVoiceCallMarker({ records: [] } as never)).toBeNull();
    expect(readVoiceCallMarker(marker({ callId: "call-1" }))).toBeNull();
    expect(
      readVoiceCallMarker({
        records: [{ kind: "personal-task", payload: { taskId: "t-1" } }],
      } as never),
    ).toBeNull();
  });

  it("names the tag in one place", () => {
    expect(VOICE_CALL_TAG_LABEL).toBe("From the call");
  });
});
