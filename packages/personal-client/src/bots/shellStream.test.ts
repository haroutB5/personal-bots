import { ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyShellStreamItem, EMPTY_BOT_SHELLS } from "./shellStream.ts";

const thread = (id: string, title: string) =>
  ({ id, title }) as unknown as OrchestrationThreadShell;

const titles = (shells: ReadonlyMap<string, OrchestrationThreadShell>) =>
  Object.fromEntries([...shells].map(([id, shell]) => [id, shell.title]));

describe("applyShellStreamItem", () => {
  it("a snapshot opens the map", () => {
    const next = applyShellStreamItem(EMPTY_BOT_SHELLS, {
      type: "snapshot",
      threads: [thread("a", "Alpha"), thread("b", "Beta")],
    });
    expect(titles(next)).toEqual({ a: "Alpha", b: "Beta" });
  });

  it("an upsert updates one chat and adds another", () => {
    const snapshot = applyShellStreamItem(EMPTY_BOT_SHELLS, {
      type: "snapshot",
      threads: [thread("a", "Alpha"), thread("b", "Beta")],
    });
    const next = applyShellStreamItem(snapshot, {
      type: "upsert",
      threads: [thread("a", "Alpha renamed"), thread("c", "Gamma")],
    });
    expect(titles(next)).toEqual({ a: "Alpha renamed", b: "Beta", c: "Gamma" });
  });

  it("a removed item drops the named chat and keeps the rest", () => {
    const snapshot = applyShellStreamItem(EMPTY_BOT_SHELLS, {
      type: "snapshot",
      threads: [thread("a", "Alpha"), thread("b", "Beta"), thread("c", "Gamma")],
    });
    const next = applyShellStreamItem(snapshot, {
      type: "removed",
      threadIds: [ThreadId.make("b")],
    });
    expect(titles(next)).toEqual({ a: "Alpha", c: "Gamma" });
  });

  it("a later snapshot replaces the map instead of merging into it", () => {
    const first = applyShellStreamItem(EMPTY_BOT_SHELLS, {
      type: "snapshot",
      threads: [thread("a", "Alpha")],
    });
    const second = applyShellStreamItem(first, {
      type: "snapshot",
      threads: [thread("b", "Beta")],
    });
    expect(titles(second)).toEqual({ b: "Beta" });
  });
});
