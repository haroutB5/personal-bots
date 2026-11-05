import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  PersonalBotThreadShellsInput,
  PersonalBotTokenUsageInput,
  PersonalLeadBotChangeDecideInput,
  PersonalMemoryCardsInput,
  PersonalMemoryTidyDecideInput,
  PersonalTaskIdInput,
  WS_METHODS,
} from "@t3tools/contracts";

const decodeThreadShells = Schema.decodeUnknownSync(PersonalBotThreadShellsInput);
const decodeTokenUsage = Schema.decodeUnknownSync(PersonalBotTokenUsageInput);
const decodeLeadDecide = Schema.decodeUnknownSync(PersonalLeadBotChangeDecideInput);
const decodeMemoryCards = Schema.decodeUnknownSync(PersonalMemoryCardsInput);
const decodeMemoryDecide = Schema.decodeUnknownSync(PersonalMemoryTidyDecideInput);
const decodeTask = Schema.decodeUnknownSync(PersonalTaskIdInput);

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

describe("A6 rpc contract", () => {
  it("names the tags the phone calls", () => {
    expect(WS_METHODS.personalLeadBotChangesList).toBe("personalLeadBotChanges.list");
    expect(WS_METHODS.personalLeadBotChangesDecide).toBe("personalLeadBotChanges.decide");
    expect(WS_METHODS.personalTasksSubscribe).toBe("personalTasks.subscribe");
    expect(WS_METHODS.personalTasksGet).toBe("personalTasks.get");
    expect(WS_METHODS.personalMemoryCards).toBe("personalMemory.cards");
    expect(WS_METHODS.personalMemoryRulesUsage).toBe("personalMemory.rulesUsage");
  });

  it("decodes the card commands the phone sends", () => {
    expect(decodeLeadDecide({ changeId: "c1", changeHash: "abc", decision: "approved" })).toEqual({
      changeId: "c1",
      changeHash: "abc",
      decision: "approved",
    });
    expect(decodeMemoryCards({ threadId: "th1" })).toEqual({ threadId: "th1" });
    expect(decodeMemoryDecide({ changeId: 7, approve: false, changeHash: "abc" })).toEqual({
      changeId: 7,
      approve: false,
      changeHash: "abc",
    });
    expect(decodeTask({ taskId: "t1" })).toEqual({ taskId: "t1" });
  });
});
