// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";

import { BOT_PROCESS_PRIORITY_ENV } from "../botProcessPriority.ts";

import { makeClaudeProcessHandle, makeRecordingClaudeSpawner } from "./claudeProcessSpawner.ts";

const spawnOptions = (signal: AbortSignal) => ({
  command: process.execPath,
  args: ["-e", "setTimeout(() => {}, 20)"],
  env: process.env as Record<string, string | undefined>,
  signal,
});

const waitForExit = (child: { once(event: "exit", listener: () => void): unknown }) =>
  new Promise<void>((resolve) => child.once("exit", () => resolve()));

describe("makeRecordingClaudeSpawner priority", () => {
  it("lowers the CLI's priority by its PID right after the spawn", async () => {
    const handle = makeClaudeProcessHandle();
    const lowered: Array<number | undefined> = [];
    const spawned = makeRecordingClaudeSpawner(handle, undefined, (pid) => lowered.push(pid))(
      spawnOptions(new AbortController().signal),
    );
    await waitForExit(spawned);
    assert.isDefined(handle.child?.pid);
    assert.deepEqual(lowered, [handle.child?.pid]);
  });

  it("lowers it for every spawn of a session that resumes", async () => {
    const handle = makeClaudeProcessHandle();
    const lowered: Array<number | undefined> = [];
    const spawn = makeRecordingClaudeSpawner(handle, undefined, (pid) => lowered.push(pid));
    const first = spawn(spawnOptions(new AbortController().signal));
    await waitForExit(first);
    const second = spawn(spawnOptions(new AbortController().signal));
    await waitForExit(second);
    assert.strictEqual(lowered.length, 2);
    assert.notStrictEqual(lowered[0], lowered[1]);
  });
});

// The class a real child ends up with, read back from Windows.
// oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform, outside any Effect runtime.
describe.skipIf(NodeOS.platform() !== "win32")("makeRecordingClaudeSpawner real priority", () => {
  const runAndRead = async (env: string | undefined) => {
    const saved = process.env[BOT_PROCESS_PRIORITY_ENV];
    if (env === undefined) delete process.env[BOT_PROCESS_PRIORITY_ENV];
    else process.env[BOT_PROCESS_PRIORITY_ENV] = env;
    try {
      const handle = makeClaudeProcessHandle();
      const spawned = makeRecordingClaudeSpawner(handle)({
        ...spawnOptions(new AbortController().signal),
        args: ["-e", "setTimeout(() => {}, 5000)"],
      });
      const pid = handle.child?.pid;
      assert.isDefined(pid);
      const priority = NodeOS.getPriority(pid!);
      const exited = waitForExit(spawned);
      handle.child?.kill();
      await exited;
      return priority;
    } finally {
      if (saved === undefined) delete process.env[BOT_PROCESS_PRIORITY_ENV];
      else process.env[BOT_PROCESS_PRIORITY_ENV] = saved;
    }
  };

  it("starts the CLI at BelowNormal", async () => {
    assert.strictEqual(
      await runAndRead(undefined),
      NodeOS.constants.priority.PRIORITY_BELOW_NORMAL,
    );
  });

  it("leaves what the spawn gave it with PERSONAL_BOT_PROCESS_PRIORITY=normal", async () => {
    // Windows hands a child its parent's class only when that is BelowNormal or Idle.
    const own = NodeOS.getPriority(process.pid);
    const expected =
      own > NodeOS.constants.priority.PRIORITY_NORMAL
        ? own
        : NodeOS.constants.priority.PRIORITY_NORMAL;
    assert.strictEqual(await runAndRead("normal"), expected);
  });
});

describe("makeRecordingClaudeSpawner exits", () => {
  const exitsLater = (signal: AbortSignal, code: number) => ({
    ...spawnOptions(signal),
    args: ["-e", `setTimeout(() => process.exit(${code}), 150)`],
  });

  it("reports an exit nobody asked for as not requested", async () => {
    const handle = makeClaudeProcessHandle();
    const details: Array<{ requested: boolean; code: number | null }> = [];
    const spawned = makeRecordingClaudeSpawner(
      handle,
      (detail) => details.push({ requested: detail.requested, code: detail.code }),
      () => undefined,
    )(exitsLater(new AbortController().signal, 3));
    await waitForExit(spawned);
    assert.deepEqual(details, [{ requested: false, code: 3 }]);
  });

  it("reports the exit that follows a stop the session asked for as requested", async () => {
    // An archived chat ends its CLI through the SDK, which is not an abort of the spawn signal.
    const handle = makeClaudeProcessHandle();
    const details: Array<{ requested: boolean; code: number | null }> = [];
    const spawned = makeRecordingClaudeSpawner(
      handle,
      (detail) => details.push({ requested: detail.requested, code: detail.code }),
      () => undefined,
    )(exitsLater(new AbortController().signal, 1));
    handle.stopRequested = true;
    await waitForExit(spawned);
    assert.deepEqual(details, [{ requested: true, code: 1 }]);
  });

  it("a clean exit and an abort say nothing; a resumed session starts unrequested again", async () => {
    const handle = makeClaudeProcessHandle();
    const details: Array<boolean> = [];
    const spawn = makeRecordingClaudeSpawner(
      handle,
      (detail) => details.push(detail.requested),
      () => undefined,
    );
    const clean = spawn(exitsLater(new AbortController().signal, 0));
    handle.stopRequested = true;
    await waitForExit(clean);
    assert.deepEqual(details, []);
    const next = spawn(exitsLater(new AbortController().signal, 2));
    assert.isFalse(handle.stopRequested);
    await waitForExit(next);
    assert.deepEqual(details, [false]);
  });
});
