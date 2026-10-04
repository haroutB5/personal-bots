// @effect-diagnostics globalDate:off - the registry under test keeps plain epoch milliseconds.
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  beginStallJob,
  fingerprintSql,
  noteGc,
  noteSlowOp,
  resetStallContextForTests,
  snapshotStallWindow,
  stallRecorderEnabled,
} from "./stallContext.ts";

afterEach(() => resetStallContextForTests());

describe("stallContext", () => {
  it("masks literals so a statement can be logged", () => {
    expect(
      fingerprintSql(
        "SELECT * FROM chats\n  WHERE thread_id = 'abc-123' AND title = 'it''s' LIMIT 20 OFFSET 3.5",
      ),
    ).toBe("SELECT * FROM chats WHERE thread_id = ? AND title = ? LIMIT ? OFFSET ?");
  });

  it("cuts a long statement short", () => {
    const text = fingerprintSql(`SELECT ${"column_name, ".repeat(40)}x FROM t`);
    expect(text.length).toBeLessThanOrEqual(143);
    expect(text.endsWith("...")).toBe(true);
  });

  it("lists a running job and forgets a short finished one", () => {
    const end = beginStallJob("job:test-running");
    const during = snapshotStallWindow(Date.now() - 1000, Date.now());
    expect(during.jobs.map((job) => [job.name, job.endedAt])).toEqual([["job:test-running", null]]);
    end();
    end();
    expect(snapshotStallWindow(Date.now() - 1000, Date.now()).jobs).toEqual([]);
  });

  it("keeps a long finished job for the stall window it overlaps", async () => {
    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    try {
      const end = beginStallJob("job:test-long");
      const startedAt = clock;
      clock += 4000;
      end();
      const window = snapshotStallWindow(startedAt + 1000, startedAt + 2500);
      expect(window.jobs).toEqual([{ name: "job:test-long", startedAt, endedAt: clock }]);
      expect(snapshotStallWindow(clock + 10, clock + 20).jobs).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });

  it("notes only calls that held the loop long enough", () => {
    const tooQuick = performance.now() - 20;
    noteSlowOp("sql", tooQuick, 1, () => "SELECT 1");
    const slow = performance.now() - 450;
    noteSlowOp("sql", slow, 12, () => "SELECT * FROM t WHERE id = 'secret value'");
    noteSlowOp("fs", performance.now() - 300, 2048, () => "server.trace.ndjson");
    const ops = snapshotStallWindow(Date.now() - 1000, Date.now()).ops;
    expect(ops.map((op) => [op.kind, op.label, op.size])).toEqual([
      ["sql", "SELECT * FROM t WHERE id = ?", 12],
      ["fs", "server.trace.ndjson", 2048],
    ]);
    expect(ops[0]!.ms).toBeGreaterThanOrEqual(450);
  });

  it("never reads the label of a quick call", () => {
    let read = false;
    noteSlowOp("sql", performance.now(), 0, () => {
      read = true;
      return "SELECT 1";
    });
    expect(read).toBe(false);
  });

  it("keeps garbage collections inside the window", () => {
    const now = Date.now();
    noteGc("major", 180, now - 100);
    noteGc("minor", 60, now - 60_000);
    expect(snapshotStallWindow(now - 1000, now).gc).toEqual([
      { kind: "major", ms: 180, at: now - 100 },
    ]);
  });

  it("is on unless the kill switch is set", () => {
    expect(stallRecorderEnabled()).toBe(true);
  });
});
