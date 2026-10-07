import { CHAT_NAME_TAKEN_CODE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { chatNameClash, isChatNameTakenFailure } from "./chatNames";

describe("chatNameClash", () => {
  const others = ["Main", "Weekly report", "New chat"];

  it("flags a name another open chat has, ignoring case, spaces and inner whitespace", () => {
    expect(chatNameClash("Main", others)).toBe('A chat called "Main" already exists');
    expect(chatNameClash("  main ", others)).toBe('A chat called "main" already exists');
    expect(chatNameClash("WEEKLY   report", others)).toBe(
      'A chat called "WEEKLY   report" already exists',
    );
  });

  it("lets a different name, an empty field and the unnamed placeholder through", () => {
    expect(chatNameClash("Main 2", others)).toBeNull();
    expect(chatNameClash("Mai n", others)).toBeNull();
    expect(chatNameClash("   ", others)).toBeNull();
    expect(chatNameClash("New chat", others)).toBeNull();
    expect(chatNameClash("Main", [])).toBeNull();
  });
});

describe("isChatNameTakenFailure", () => {
  it("recognises the typed refusal and nothing else", () => {
    expect(
      isChatNameTakenFailure({
        _tag: "Failure",
        cause: Cause.fail({ message: "x", code: CHAT_NAME_TAKEN_CODE }),
      } as never),
    ).toBe(true);
    expect(
      isChatNameTakenFailure({ _tag: "Failure", cause: Cause.fail({ message: "x" }) } as never),
    ).toBe(false);
    expect(isChatNameTakenFailure({ _tag: "Success", value: {} } as never)).toBe(false);
  });
});
