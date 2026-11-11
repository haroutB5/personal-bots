import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Redacted from "effect/Redacted";

import {
  PersonalBotThreadShellsInput,
  PersonalBotTokenUsageInput,
  PersonalConnectionApprovalDecideInput,
  PersonalLeadBotChangeDecideInput,
  PersonalLoginRequestsCancelInput,
  PersonalLoginRequestsSubmitInput,
  PersonalMemoryCardsInput,
  PersonalMemoryTidyDecideInput,
  PersonalSecretFulfillInput,
  PersonalSecretRequestIdInput,
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
    expect(WS_METHODS.personalPushRegisterFcm).toBe("personalPush.registerFcm");
    expect(WS_METHODS.personalPushUnregisterFcm).toBe("personalPush.unregisterFcm");
    expect(WS_METHODS.personalPushNotificationContent).toBe("personalPush.notificationContent");
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

describe("A7 rpc contract", () => {
  const decodeApproval = Schema.decodeUnknownSync(PersonalConnectionApprovalDecideInput);
  const decodeFulfill = Schema.decodeUnknownSync(PersonalSecretFulfillInput);
  const decodeSecretId = Schema.decodeUnknownSync(PersonalSecretRequestIdInput);
  const decodeLoginSubmit = Schema.decodeUnknownSync(PersonalLoginRequestsSubmitInput);
  const decodeLoginCancel = Schema.decodeUnknownSync(PersonalLoginRequestsCancelInput);

  it("names the tags the phone calls", () => {
    expect(WS_METHODS.personalSecretsListPending).toBe("personalSecrets.listPending");
    expect(WS_METHODS.personalSecretsFulfill).toBe("personalSecrets.fulfill");
    expect(WS_METHODS.personalSecretsCancel).toBe("personalSecrets.cancel");
    expect(WS_METHODS.personalLoginRequestsList).toBe("personalLoginRequests.list");
    expect(WS_METHODS.personalLoginRequestsSubmit).toBe("personalLoginRequests.submit");
    expect(WS_METHODS.personalLoginRequestsCancel).toBe("personalLoginRequests.cancel");
    expect(WS_METHODS.personalConnectionApprovalsList).toBe("personalConnectionApprovals.list");
    expect(WS_METHODS.personalConnectionApprovalsDecide).toBe("personalConnectionApprovals.decide");
  });

  it("decodes the approval and secret commands the phone sends", () => {
    expect(decodeApproval({ approvalId: "a1", decision: "approved" })).toEqual({
      approvalId: "a1",
      decision: "approved",
    });
    expect(decodeSecretId({ requestId: "s1" })).toEqual({ requestId: "s1" });
    const fulfill = decodeFulfill({
      requestId: "s1",
      value: Redacted.make("sk-test"),
      shared: false,
      mode: "brokered",
      origins: ["https://api.vercel.com"],
    });
    expect(fulfill).toMatchObject({
      requestId: "s1",
      shared: false,
      mode: "brokered",
      origins: ["https://api.vercel.com"],
    });
    expect(Redacted.value(fulfill.value)).toBe("sk-test");
  });

  it("decodes the login commands the phone sends", () => {
    const submit = decodeLoginSubmit({
      requestId: "l1",
      username: Redacted.make("me"),
      password: Redacted.make("pw"),
      save: true,
    });
    expect(submit).toMatchObject({ requestId: "l1", save: true });
    expect(Redacted.value(submit.username)).toBe("me");
    expect(Redacted.value(submit.password)).toBe("pw");
    expect(decodeLoginCancel({ requestId: "l1" })).toEqual({ requestId: "l1" });
  });
});
