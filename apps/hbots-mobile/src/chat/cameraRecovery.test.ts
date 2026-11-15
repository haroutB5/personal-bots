import { describe, expect, it } from "vite-plus/test";

import {
  CAMERA_RECOVERY_MS,
  cameraRecoveryDecision,
  type PendingCameraLaunch,
  type RecoveryChat,
} from "./cameraRecovery";

const now = 1_800_000_000_000;
const owner = "env-1/thread-1";
const chat: RecoveryChat = { botId: "bot-1", threadId: "thread-1" };

function decide(input: {
  readonly launch?: PendingCameraLaunch | null;
  readonly environmentId?: string;
  readonly chats?: ReadonlyArray<RecoveryChat> | null;
}) {
  return cameraRecoveryDecision({
    launch: input.launch === undefined ? { owner, at: now - 60_000 } : input.launch,
    environmentId: input.environmentId ?? "env-1",
    now,
    chats: input.chats === undefined ? [chat] : input.chats,
  });
}

describe("cameraRecoveryDecision", () => {
  it("does nothing when no launch is recorded", () => {
    expect(decide({ launch: null })).toEqual({ kind: "none" });
  });

  it("opens the chat that launched the camera while the record is fresh", () => {
    expect(decide({})).toEqual({ kind: "open", botId: "bot-1", threadId: "thread-1" });
  });

  it("opens the owner chat among several", () => {
    expect(
      decide({
        chats: [
          { botId: "bot-2", threadId: "thread-2" },
          { botId: "bot-1", threadId: "thread-1" },
        ],
      }),
    ).toEqual({ kind: "open", botId: "bot-1", threadId: "thread-1" });
  });

  it("leaves a record that is ten minutes old for the composer that mounts later", () => {
    expect(decide({ launch: { owner, at: now - CAMERA_RECOVERY_MS } })).toEqual({
      kind: "leave",
    });
  });

  it("opens a record one millisecond short of ten minutes", () => {
    expect(decide({ launch: { owner, at: now - CAMERA_RECOVERY_MS + 1 } })).toEqual({
      kind: "open",
      botId: "bot-1",
      threadId: "thread-1",
    });
  });

  it("waits while the chat list has not loaded", () => {
    expect(decide({ chats: null })).toEqual({ kind: "wait" });
  });

  it("drops the record and its file when the owner chat is gone", () => {
    expect(decide({ chats: [] })).toEqual({ kind: "drop", threadId: "thread-1" });
  });

  it("drops another environment's launch", () => {
    expect(decide({ environmentId: "env-2" })).toEqual({ kind: "drop", threadId: "thread-1" });
  });

  it("drops an owner that names no chat", () => {
    expect(decide({ launch: { owner: "env-1", at: now - 1_000 } })).toEqual({
      kind: "drop",
      threadId: "env-1",
    });
  });

  it("drops a chat that exists only under another thread id", () => {
    expect(decide({ chats: [{ botId: "bot-1", threadId: "thread-2" }] })).toEqual({
      kind: "drop",
      threadId: "thread-1",
    });
  });
});
