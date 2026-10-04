import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chatTurnModelSelection } from "./chatModelSelection";

const selection = (instance: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model,
});

describe("chatTurnModelSelection", () => {
  const thread = selection("codex", "gpt-6.1-sol");

  it("sends the bot's selection after it moved to another provider (stale thread copy)", () => {
    const bot = selection("claudeAgent", "claude-sonnet-5-5");
    expect(chatTurnModelSelection(bot, thread)).toBe(bot);
  });

  it("sends the bot's selection when only its model changed", () => {
    const bot = selection("codex", "gpt-6.1-sol-high");
    expect(chatTurnModelSelection(bot, thread)).toBe(bot);
  });

  it("falls back to the thread's selection while the bot is not loaded", () => {
    expect(chatTurnModelSelection(null, thread)).toBe(thread);
  });
});
