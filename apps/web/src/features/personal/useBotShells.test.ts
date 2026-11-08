import { EnvironmentId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeBotShells } from "./useBotShells";

const environmentId = EnvironmentId.make("env-1");

const shell = (id: string, title = id): OrchestrationThreadShell =>
  ({ id, title }) as unknown as OrchestrationThreadShell;

const open = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
  new Map(threads.map((thread) => [thread.id, thread] as const));

// The stream carries open chats; archived ones come back on demand and join them.
describe("mergeBotShells", () => {
  it("lists the open chats, then the asked-for archived chats the stream lacks", () => {
    const merged = mergeBotShells(environmentId, open([shell("a")]), [[shell("b"), shell("c")]]);
    expect(merged.map((thread) => thread.id)).toEqual(["a", "b", "c"]);
    expect(merged.every((thread) => thread.environmentId === environmentId)).toBe(true);
  });

  it("keeps the stream shell when both have the chat, since the stream keeps it current", () => {
    const merged = mergeBotShells(environmentId, open([shell("a", "live title")]), [
      [shell("a", "stale title"), shell("b")],
      [shell("b", "second copy")],
    ]);
    expect(merged.map((thread) => [thread.id, thread.title])).toEqual([
      ["a", "live title"],
      ["b", "b"],
    ]);
  });

  it("shows archived chats before the stream's snapshot lands", () => {
    expect(mergeBotShells(environmentId, null, [[shell("b")]]).map((thread) => thread.id)).toEqual([
      "b",
    ]);
    expect(mergeBotShells(environmentId, null, [])).toEqual([]);
  });
});
