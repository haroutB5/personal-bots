import { assert, describe, it } from "@effect/vitest";

import { cleanNotifyMessage, taskNotifyVerdict } from "./notifyDecision.ts";

const state = (
  mode: "always" | "bot_decides" | "never" | null,
  decision: boolean | null,
  message: string | null = null,
) => ({ mode, decision, message });

describe("taskNotifyVerdict", () => {
  it("always and no mode send as before; the message only changes the body", () => {
    assert.deepEqual(taskNotifyVerdict("completed", state("always", null)), { _tag: "Send" });
    assert.deepEqual(taskNotifyVerdict("completed", state(null, null)), { _tag: "Send" });
    assert.deepEqual(taskNotifyVerdict("completed", state("always", false)), { _tag: "Send" });
    assert.deepEqual(taskNotifyVerdict("completed", state("always", true, "Changed")), {
      _tag: "Send",
      body: "Changed",
    });
  });

  it("bot_decides sends only on notify true", () => {
    assert.deepEqual(taskNotifyVerdict("completed", state("bot_decides", true, "Changed")), {
      _tag: "Send",
      body: "Changed",
    });
    assert.deepEqual(taskNotifyVerdict("completed", state("bot_decides", true)), { _tag: "Send" });
    assert.deepEqual(taskNotifyVerdict("completed", state("bot_decides", false)), {
      _tag: "Skip",
      path: "bot-skipped",
    });
    assert.deepEqual(taskNotifyVerdict("completed", state("bot_decides", null)), {
      _tag: "Skip",
      path: "bot-skipped",
    });
  });

  it("never skips a completed run, whatever the bot said", () => {
    assert.deepEqual(taskNotifyVerdict("completed", state("never", true, "x")), {
      _tag: "Skip",
      path: "routine-never",
    });
  });

  it("only a completed run is ever silenced", () => {
    for (const status of ["failed", "waiting_for_user", "waiting_for_browser"]) {
      for (const mode of ["always", "bot_decides", "never"] as const) {
        assert.deepEqual(taskNotifyVerdict(status, state(mode, false)), { _tag: "Send" });
      }
    }
  });
});

describe("cleanNotifyMessage", () => {
  it("makes one clean line", () => {
    assert.equal(cleanNotifyMessage("  Price\n dropped   to 120 "), "Price dropped to 120");
    assert.equal(cleanNotifyMessage("   "), null);
    assert.equal(cleanNotifyMessage(undefined), null);
  });

  it("hides anything that looks like a key and caps the length", () => {
    assert.equal(cleanNotifyMessage("key sk-abcdef123456 leaked"), "key [hidden] leaked");
    const long = cleanNotifyMessage("x".repeat(500))!;
    assert.equal(Array.from(long).length, 200);
    assert.isTrue(long.endsWith("…"));
  });
});
