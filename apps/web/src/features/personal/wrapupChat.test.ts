import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Thread } from "~/types";

import { buildWrapupTurnInput, WRAPUP_CHAT_PROMPT } from "./wrapupChat";

const thread = {
  id: ThreadId.make("thread-1"),
  title: "Trip planning",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as Thread;

const base = {
  threadId: ThreadId.make("thread-1"),
  thread,
  botModelSelection: null,
  messageId: MessageId.make("message-1"),
  createdAt: "2026-09-13T20:40:00.000Z",
} as const;

describe("WRAPUP_CHAT_PROMPT", () => {
  it("asks for a summary persisted with the bot's save_memory tool", () => {
    expect(WRAPUP_CHAT_PROMPT).toContain("save_memory");
    expect(WRAPUP_CHAT_PROMPT).toContain("concise");
  });
});

describe("buildWrapupTurnInput", () => {
  it("sends the canned prompt as a user turn and keeps the chat's title", () => {
    const input = buildWrapupTurnInput(base);
    expect(input.threadId).toBe("thread-1");
    expect(input.message).toEqual({
      messageId: "message-1",
      role: "user",
      text: WRAPUP_CHAT_PROMPT,
      attachments: [],
    });
    expect(input.titleSeed).toBe("Trip planning");
    expect(input.runtimeMode).toBe("full-access");
    expect(input.interactionMode).toBe("default");
    expect(input.createdAt).toBe("2026-09-13T20:40:00.000Z");
  });

  it("prefers the bot's current model on the same provider instance", () => {
    const input = buildWrapupTurnInput({
      ...base,
      botModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-newer" },
    });
    expect(input.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-newer",
    });
  });

  it("keeps the thread's model when the bot moved provider instances", () => {
    const input = buildWrapupTurnInput({
      ...base,
      botModelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-fable-5-1",
      },
    });
    expect(input.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
    });
  });
});
