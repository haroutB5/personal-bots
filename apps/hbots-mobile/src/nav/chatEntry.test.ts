import { describe, expect, it } from "vite-plus/test";

import { chatStackAnimation } from "./chatEntry";

describe("chatStackAnimation", () => {
  it("slides a chat in when it opens from another screen", () => {
    expect(chatStackAnimation(undefined)).toBe("ios_from_right");
  });

  it("does not slide when the chat was reached by a chip", () => {
    expect(chatStackAnimation("chip")).toBe("none");
  });
});
