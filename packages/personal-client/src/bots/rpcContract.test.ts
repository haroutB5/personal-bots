import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  PersonalBotThreadShellsInput,
  PersonalBotTokenUsageInput,
  WS_METHODS,
} from "@t3tools/contracts";

const decodeThreadShells = Schema.decodeUnknownSync(PersonalBotThreadShellsInput);
const decodeTokenUsage = Schema.decodeUnknownSync(PersonalBotTokenUsageInput);

describe("A2 rpc contract", () => {
  it("names the tags the phone calls", () => {
    expect(WS_METHODS.personalBotsList).toBe("personalBots.list");
    expect(WS_METHODS.personalBotsGetProfile).toBe("personalBots.getProfile");
    expect(WS_METHODS.personalBotsTokenUsage).toBe("personalBots.tokenUsage");
    expect(WS_METHODS.personalBotsWorkingProgress).toBe("personalBots.workingProgress");
    expect(WS_METHODS.personalBotsThreadShells).toBe("personalBots.threadShells");
    expect(WS_METHODS.personalPushInApp).toBe("personalPush.inApp");
    expect(WS_METHODS.personalPushAckInApp).toBe("personalPush.ackInApp");
  });

  it("decodes the thread-shells input the phone sends", () => {
    expect(decodeThreadShells({ threadIds: ["0c4b1d06-0000-4000-8000-000000000001"] })).toEqual({
      threadIds: ["0c4b1d06-0000-4000-8000-000000000001"],
    });
  });

  it("decodes the token-usage input the phone sends", () => {
    expect(decodeTokenUsage({ timeZone: "Europe/London" })).toEqual({
      timeZone: "Europe/London",
    });
  });
});
