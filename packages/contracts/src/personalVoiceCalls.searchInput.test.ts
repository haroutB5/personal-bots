import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { VOICE_CALL_SEARCH_INPUT_CHARS, VoiceCallSearchWebInput } from "./personalVoiceCalls.ts";

const decode = Schema.decodeUnknownSync(VoiceCallSearchWebInput);
const input = (query: string) => ({ threadId: "thread-1", callId: "call-1", query });

describe("VoiceCallSearchWebInput", () => {
  it("accepts a query up to the cap and refuses a longer one", () => {
    expect(VOICE_CALL_SEARCH_INPUT_CHARS).toBe(2_000);
    expect(decode(input("a".repeat(VOICE_CALL_SEARCH_INPUT_CHARS))).query).toHaveLength(2_000);
    expect(() => decode(input("a".repeat(VOICE_CALL_SEARCH_INPUT_CHARS + 1)))).toThrow();
  });

  it("still refuses an empty query", () => {
    expect(() => decode(input("   "))).toThrow();
  });
});
