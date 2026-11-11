import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  PersonalPushForegroundInput,
  PersonalPushPreferences,
  PersonalPushViewingInput,
  WS_METHODS,
} from "@t3tools/contracts";

const decodeViewing = Schema.decodeUnknownSync(PersonalPushViewingInput);
const decodeForeground = Schema.decodeUnknownSync(PersonalPushForegroundInput);
const decodePreferences = Schema.decodeUnknownSync(PersonalPushPreferences);

describe("N1 push rpc contract", () => {
  it("names the tags the phone calls", () => {
    expect(WS_METHODS.personalPushReportViewing).toBe("personalPush.reportViewing");
    expect(WS_METHODS.personalPushReportForeground).toBe("personalPush.reportForeground");
    expect(WS_METHODS.personalPushSetPreferences).toBe("personalPush.setPreferences");
  });

  it("decodes the viewing report the chat screen sends", () => {
    expect(decodeViewing({ threadId: null })).toEqual({ threadId: null });
    expect(decodeViewing({ threadId: "0c4b1d06-0000-4000-8000-000000000001" })).toEqual({
      threadId: "0c4b1d06-0000-4000-8000-000000000001",
    });
    expect(() => decodeViewing({})).toThrow();
  });

  it("decodes the foreground heartbeat the app sends", () => {
    expect(decodeForeground({ foreground: true })).toEqual({ foreground: true });
    expect(() => decodeForeground({ foreground: "yes" })).toThrow();
  });

  it("decodes the five event toggles the Notifications screen saves", () => {
    const value = {
      taskCompleted: true,
      taskNeedsInput: true,
      taskFailed: false,
      routineResult: true,
      chatReply: false,
    };
    expect(decodePreferences(value)).toEqual(value);
  });
});
