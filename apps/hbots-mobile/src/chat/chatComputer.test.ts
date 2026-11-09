import { describe, expect, it } from "vite-plus/test";

import { initialNav, switchTab } from "../nav/routes";
import { chatComputerTarget } from "./chatComputer";

describe("chatComputerTarget", () => {
  it("opens the Computer tab from a chat", () => {
    const target = chatComputerTarget();
    expect(target).toEqual({ tab: "computer" });
    expect(switchTab(initialNav, target.tab)).toEqual({
      stack: [{ kind: "tab", tab: "computer" }],
    });
  });
});
