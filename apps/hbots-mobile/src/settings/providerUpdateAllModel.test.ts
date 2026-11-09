import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderRow } from "@hbots/personal-client/settings/providerRows";
import { describe, expect, it } from "vite-plus/test";

import { runProviderUpdates, updateAllTargets, updateFailureLines } from "./providerUpdateAllModel";

const updateAction = { kind: "update", label: "Update" } as const;

function row(overrides: Partial<ProviderRow>): ProviderRow {
  return {
    instanceId: "claude",
    driver: "claudeCode" as ProviderDriverKind,
    label: "Claude Code",
    state: "ready",
    dot: "live",
    statusText: "Version 2.0.0",
    tone: "normal",
    detail: null,
    action: null,
    progress: null,
    busy: false,
    bots: [],
    canToggleUsage: false,
    ...overrides,
  };
}

describe("update all targets", () => {
  it("picks only idle providers that offer Update, in screen order", () => {
    const targets = updateAllTargets([
      row({ instanceId: "claude", label: "Claude Code", action: updateAction }),
      row({
        instanceId: "codex",
        label: "Codex",
        state: "updateAvailable",
        action: updateAction,
      }),
      row({
        instanceId: "cursor",
        label: "Cursor",
        state: "updateAvailable",
        action: { kind: "tryAgain", label: "Try again" },
      }),
      row({ instanceId: "grok", label: "Grok", action: updateAction, busy: true }),
      row({ instanceId: "unset", label: "Unset", driver: null, action: updateAction }),
    ]);

    expect(targets.map((target) => target.instanceId)).toEqual(["claude", "codex"]);
  });
});

describe("run updates", () => {
  it("runs one at a time, skips rows without Update, and keeps going after a failure", async () => {
    const rows = [
      row({ instanceId: "claude", label: "Claude Code", action: updateAction }),
      row({ instanceId: "codex", label: "Codex", action: updateAction }),
      row({
        instanceId: "cursor",
        label: "Cursor",
        action: { kind: "signIn", label: "Sign in" },
      }),
      row({ instanceId: "grok", label: "Grok", action: updateAction }),
    ];
    const started: Array<string> = [];
    let running = 0;
    let mostRunningAtOnce = 0;

    const failures = await runProviderUpdates(rows, async (target) => {
      started.push(target.instanceId);
      running += 1;
      mostRunningAtOnce = Math.max(mostRunningAtOnce, running);
      await Promise.resolve();
      running -= 1;
      return target.instanceId === "codex" ? "Update failed" : null;
    });

    expect(started).toEqual(["claude", "codex", "grok"]);
    expect(mostRunningAtOnce).toBe(1);
    expect(failures).toEqual([{ instanceId: "codex", label: "Codex", message: "Update failed" }]);
  });

  it("names every provider that failed", () => {
    expect(
      updateFailureLines([
        { instanceId: "codex", label: "Codex", message: "Update failed" },
        { instanceId: "grok", label: "Grok", message: "Not connected." },
      ]),
    ).toBe("Codex: Update failed\nGrok: Not connected.");
  });
});
