import { assert, describe, it } from "@effect/vitest";

import {
  isMissingProviderConversationText,
  missingProviderConversationLine,
} from "./missingProviderConversation.ts";

describe("isMissingProviderConversationText", () => {
  it("recognises Claude and Codex missing-conversation errors", () => {
    assert.isTrue(
      isMissingProviderConversationText(
        "No conversation found with session ID: 853cc750-05e8-4fe6-92e7-48ffd8259294",
      ),
    );
    assert.isTrue(isMissingProviderConversationText("thread/resume failed: no rollout found"));
    assert.isTrue(isMissingProviderConversationText("thread 019a-abc not found"));
  });

  it("leaves other failures alone", () => {
    assert.isFalse(isMissingProviderConversationText("turn/setPermissionMode failed"));
    assert.isFalse(isMissingProviderConversationText("Claude usage limit reached."));
    assert.isFalse(isMissingProviderConversationText("File not found: photo.png"));
    assert.isFalse(isMissingProviderConversationText(undefined));
  });

  it("finds the line that says so in a stderr tail", () => {
    assert.equal(
      missingProviderConversationLine(
        "warming up\nNo conversation found with session ID: 853cc750\n",
      ),
      "No conversation found with session ID: 853cc750",
    );
    assert.isUndefined(missingProviderConversationLine("exited with code 1"));
  });
});
