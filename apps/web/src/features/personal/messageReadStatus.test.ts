import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessageContext,
  type OrchestrationThreadActivity,
  withPersonalFollowUp,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "~/session-logic";
import type { ChatMessage } from "~/types";

import type { ConversationItem } from "./conversationModel";
import { deriveLatestMessageReadStatus, USER_MESSAGE_DELIVERED_KIND } from "./messageReadStatus";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 27, 10, 0, seconds)).toISOString();

function message(
  id: string,
  role: "user" | "assistant",
  seconds: number,
  context?: OrchestrationMessageContext,
): ConversationItem {
  const chat: ChatMessage = {
    id: MessageId.make(id),
    role,
    text: `${role} ${id}`,
    turnId: null,
    streaming: false,
    createdAt: at(seconds),
    updatedAt: at(seconds),
    ...(context !== undefined ? { context } : {}),
  } as ChatMessage;
  return { kind: "message", id, message: chat };
}

/** A "Queue after this turn" send, exactly as the composer writes it. */
function queuedMessage(id: string, seconds: number): ConversationItem {
  return message(id, "user", seconds, withPersonalFollowUp(null, "queue") ?? undefined);
}

function delivered(messageId: string, seconds: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${messageId}:delivered:${seconds}`),
    createdAt: at(seconds),
    tone: "info",
    kind: USER_MESSAGE_DELIVERED_KIND,
    summary: "Message read",
    payload: { messageId },
    turnId: TurnId.make("turn-1"),
  } as OrchestrationThreadActivity;
}

function toolActivity(seconds: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(`tool-${seconds}`),
    createdAt: at(seconds),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: { itemType: "command_execution", title: "Ran command" },
    turnId: TurnId.make("turn-1"),
  } as OrchestrationThreadActivity;
}

function runningTurn(requestedSeconds: number, turnId = "turn-1"): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(turnId),
    state: "running",
    requestedAt: at(requestedSeconds),
    startedAt: at(requestedSeconds),
    completedAt: null,
    assistantMessageId: null,
  };
}

const completedTurn: OrchestrationLatestTurn = {
  ...runningTurn(0),
  state: "completed",
  completedAt: at(40),
};

describe("deriveLatestMessageReadStatus", () => {
  it("shows Steering for a plain mid-turn send, then Read once delivered", () => {
    const items = [
      message("m1", "user", 0),
      message("a1", "assistant", 5),
      message("m2", "user", 20),
    ];
    const busy = { items, busy: true, latestTurn: runningTurn(1) };

    // A plain tap steers: absent `followUp` is the contract's default.
    expect(deriveLatestMessageReadStatus({ ...busy, activities: [] })).toEqual({
      messageId: "m2",
      status: "steering",
    });
    // The Claude steer path: the CLI folds it in at the next tool result.
    expect(deriveLatestMessageReadStatus({ ...busy, activities: [delivered("m2", 30)] })).toEqual({
      messageId: "m2",
      status: "read",
    });
  });

  it("shows Queued only for a send that explicitly asked to wait", () => {
    const items = [
      message("m1", "user", 0),
      message("a1", "assistant", 5),
      queuedMessage("m2", 20),
    ];
    const busy = { items, busy: true, latestTurn: runningTurn(1) };

    expect(deriveLatestMessageReadStatus({ ...busy, activities: [] })).toEqual({
      messageId: "m2",
      status: "queued",
    });
    // The queued message is its own turn once the running one ends: Read.
    expect(deriveLatestMessageReadStatus({ ...busy, activities: [delivered("m2", 30)] })).toEqual({
      messageId: "m2",
      status: "read",
    });
  });

  it("reads the queue choice back after a reload, from the message alone", () => {
    // Only the persisted transcript and activities exist: the marker rides on
    // the message's context, so nothing device-local is needed.
    const items = [message("m1", "user", 0), queuedMessage("m2", 20)];
    expect(
      deriveLatestMessageReadStatus({
        items,
        activities: [],
        busy: true,
        latestTurn: runningTurn(1),
      }),
    ).toEqual({ messageId: "m2", status: "queued" });
    // A plain steer is the other side of the same reload: no marker, Steering.
    expect(
      deriveLatestMessageReadStatus({
        items: [message("m1", "user", 0), message("m2", "user", 20)],
        activities: [],
        busy: true,
        latestTurn: runningTurn(1),
      }),
    ).toEqual({ messageId: "m2", status: "steering" });
  });

  it("does not flip to Read on bot output unrelated to the message", () => {
    // The bot keeps working on the step it was already doing: new text and a
    // tool call after the send, but the provider has not taken the message in.
    const items = [
      message("m1", "user", 0),
      message("m2", "user", 20),
      message("a1", "assistant", 25),
    ];
    expect(
      deriveLatestMessageReadStatus({
        items,
        activities: [delivered("m1", 1), toolActivity(26)],
        busy: true,
        latestTurn: runningTurn(1),
      }),
    ).toEqual({ messageId: "m2", status: "steering" });
  });

  it("goes straight to Read for an idle send that starts its own turn", () => {
    const items = [message("m1", "user", 50)];
    // The turn it started is running but has not reported delivery yet.
    expect(
      deriveLatestMessageReadStatus({
        items,
        activities: [],
        busy: true,
        latestTurn: runningTurn(50),
      }),
    ).toBeNull();
    expect(
      deriveLatestMessageReadStatus({
        items,
        activities: [delivered("m1", 50)],
        busy: true,
        latestTurn: runningTurn(50),
      }),
    ).toEqual({ messageId: "m1", status: "read" });
  });

  it("keeps the right state after a reload: Read stays Read, nothing on older messages", () => {
    const items = [
      message("m1", "user", 0),
      message("a1", "assistant", 5),
      message("m2", "user", 20),
    ];
    const activities = [delivered("m1", 1), delivered("m2", 21)];
    // A reload rebuilds from the persisted transcript and activities alone.
    expect(
      deriveLatestMessageReadStatus({
        items,
        activities,
        busy: false,
        latestTurn: completedTurn,
      }),
    ).toEqual({ messageId: "m2", status: "read" });
  });

  it("shows nothing, not a stuck Queued, once the bot is idle without taking it in", () => {
    const items = [message("m1", "user", 20)];
    expect(
      deriveLatestMessageReadStatus({
        items,
        activities: [],
        busy: false,
        latestTurn: completedTurn,
      }),
    ).toBeNull();
  });

  it("keeps the delivery record out of the work log", () => {
    expect(deriveWorkLogEntries([delivered("m1", 1)])).toEqual([]);
  });
});
