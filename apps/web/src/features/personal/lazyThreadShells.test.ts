import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mergeLazyThreadShells } from "~/state/lazyThreadShells";

const shell = (id: string, title = id): OrchestrationThreadShell =>
  ({ id, title }) as unknown as OrchestrationThreadShell;

const base = (threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot =>
  ({
    snapshotSequence: 3,
    projects: [],
    threads,
    updatedAt: "2026-10-26T00:00:00.000Z",
  }) as OrchestrationShellSnapshot;

// The slim shell's archived chats come back on demand and join the snapshot.
describe("mergeLazyThreadShells", () => {
  it("appends asked-for shells the base lacks", () => {
    const merged = mergeLazyThreadShells(base([shell("a")]), [[shell("b"), shell("c")]]);
    expect(merged.threads.map((thread) => thread.id)).toEqual(["a", "b", "c"]);
    expect(merged.snapshotSequence).toBe(3);
  });

  it("keeps the base shell when both have the thread, since the stream keeps it current", () => {
    const merged = mergeLazyThreadShells(base([shell("a", "live title")]), [
      [shell("a", "stale title"), shell("b")],
      [shell("b", "second copy")],
    ]);
    expect(merged.threads.map((thread) => [thread.id, thread.title])).toEqual([
      ["a", "live title"],
      ["b", "b"],
    ]);
  });

  it("returns the base itself when nothing is added", () => {
    const snapshot = base([shell("a")]);
    expect(mergeLazyThreadShells(snapshot, [])).toBe(snapshot);
    expect(mergeLazyThreadShells(snapshot, [[]])).toBe(snapshot);
    expect(mergeLazyThreadShells(snapshot, [[shell("a")]])).toBe(snapshot);
  });
});
