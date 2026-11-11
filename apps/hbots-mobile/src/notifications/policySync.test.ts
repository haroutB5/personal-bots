import { describe, expect, it } from "vite-plus/test";

import { buildNativePolicy, MAX_POLICY_BOTS } from "./policySync";

const LOCK_ON = { kind: "on", timeout: "immediate" } as const;
const LOCK_OFF = { kind: "off" } as const;

describe("buildNativePolicy", () => {
  it("carries the lock flag", () => {
    expect(buildNativePolicy([], LOCK_ON).appLockOn).toBe(true);
    expect(buildNativePolicy([], LOCK_OFF).appLockOn).toBe(false);
  });

  it("carries the name and the hide-previews switch per bot", () => {
    const policy = buildNativePolicy(
      [
        { botId: "b1", name: "Juno", hidePreviews: true },
        { botId: "b2", name: "Atlas" },
      ],
      LOCK_OFF,
    );
    expect(policy.bots).toEqual([
      { botId: "b1", name: "Juno", hidePreviews: true },
      { botId: "b2", name: "Atlas", hidePreviews: false },
    ]);
  });

  it("names a bot without a name hbots", () => {
    const policy = buildNativePolicy(
      [{ botId: "b1", name: "  " }, { botId: "b2", name: null }, { botId: "b3" }],
      LOCK_OFF,
    );
    expect(policy.bots.map((bot) => bot.name)).toEqual(["hbots", "hbots", "hbots"]);
  });

  it("sends nothing else about a bot", () => {
    const policy = buildNativePolicy(
      [{ botId: "b1", name: "Juno", secret: "x", instructions: "y" } as never],
      LOCK_OFF,
    );
    expect(Object.keys(policy.bots[0] ?? {}).sort()).toEqual(["botId", "hidePreviews", "name"]);
  });

  it("caps the list the native side will accept", () => {
    const bots = Array.from({ length: MAX_POLICY_BOTS + 20 }, (_, i) => ({ botId: `b${i}` }));
    expect(buildNativePolicy(bots, LOCK_OFF).bots).toHaveLength(MAX_POLICY_BOTS);
  });
});
