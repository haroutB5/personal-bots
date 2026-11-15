import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskDisplayTitle } from "./taskPresentation.ts";

const RAW = "MCPONCE delegate_task {...}";
const ownerRoot = {
  source: "user",
  parentTaskId: null,
  threadId: ThreadId.make("t1"),
  title: RAW,
} as const;

describe("taskDisplayTitle", () => {
  it("names an owner's request after its chat", () => {
    expect(taskDisplayTitle(ownerRoot, new Map([["t1", "Image speed"]]))).toBe("Image speed");
  });

  it("keeps the stored title while the chat has only its placeholder name", () => {
    expect(taskDisplayTitle(ownerRoot, new Map([["t1", "New chat"]]))).toBe(RAW);
    expect(taskDisplayTitle(ownerRoot, new Map([["t1", "New thread"]]))).toBe(RAW);
    expect(taskDisplayTitle(ownerRoot, new Map())).toBe(RAW);
  });

  it("keeps a delegated task's own title whatever its chat is called", () => {
    const delegated = {
      source: "delegation",
      parentTaskId: null,
      threadId: ThreadId.make("t1"),
      title: "Check the archived chip",
    } as const;
    expect(taskDisplayTitle(delegated, new Map([["t1", "Image speed"]]))).toBe(
      "Check the archived chip",
    );
  });
});
