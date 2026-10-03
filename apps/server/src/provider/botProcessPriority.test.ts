import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";

import {
  BOT_PROCESS_PRIORITY_ENV,
  botProcessPriorityDisabled,
  lowerBotProcessPriority,
} from "./botProcessPriority.ts";

const BELOW_NORMAL = NodeOS.constants.priority.PRIORITY_BELOW_NORMAL;

const recorder = () => {
  const calls: Array<{ pid: number; priority: number }> = [];
  return {
    calls,
    setPriority: (pid: number, priority: number) => void calls.push({ pid, priority }),
  };
};

describe("lowerBotProcessPriority", () => {
  it("sets BelowNormal on the given PID on Windows", () => {
    const { calls, setPriority } = recorder();
    const result = lowerBotProcessPriority(4242, { env: {}, platform: "win32", setPriority });
    assert.deepEqual(result, { status: "applied" });
    assert.deepEqual(calls, [{ pid: 4242, priority: BELOW_NORMAL }]);
  });

  it("is a no-op with the kill switch, whatever its spelling", () => {
    for (const value of ["normal", "NORMAL", " off ", "0", "false"]) {
      const { calls, setPriority } = recorder();
      const result = lowerBotProcessPriority(4242, {
        env: { [BOT_PROCESS_PRIORITY_ENV]: value },
        platform: "win32",
        setPriority,
      });
      assert.deepEqual(result, { status: "skipped", reason: "disabled" }, value);
      assert.deepEqual(calls, [], value);
    }
  });

  it("stays on for unset and for any other value", () => {
    for (const env of [
      {},
      { [BOT_PROCESS_PRIORITY_ENV]: "belownormal" },
      { [BOT_PROCESS_PRIORITY_ENV]: "" },
    ]) {
      assert.isFalse(botProcessPriorityDisabled(env), JSON.stringify(env));
    }
  });

  it("does nothing off Windows, where a child's priority is its own business", () => {
    const { calls, setPriority } = recorder();
    const result = lowerBotProcessPriority(4242, { env: {}, platform: "linux", setPriority });
    assert.deepEqual(result, { status: "skipped", reason: "unsupported-platform" });
    assert.deepEqual(calls, []);
  });

  it("ignores a missing or system PID", () => {
    const { calls, setPriority } = recorder();
    for (const pid of [undefined, 0, 4, -1, 1.5]) {
      assert.deepEqual(lowerBotProcessPriority(pid, { env: {}, platform: "win32", setPriority }), {
        status: "skipped",
        reason: "no-pid",
      });
    }
    assert.deepEqual(calls, []);
  });

  it("reports a failure instead of throwing, so the bot still runs", () => {
    const result = lowerBotProcessPriority(4242, {
      env: {},
      platform: "win32",
      setPriority: () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      },
    });
    assert.deepEqual(result, { status: "failed", code: "ESRCH", message: "no such process" });
  });
});
