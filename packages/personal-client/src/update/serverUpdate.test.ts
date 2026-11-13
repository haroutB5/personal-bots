import { describe, expect, it } from "vite-plus/test";

import {
  parseServerUpdate,
  serverUpdatePollMs,
  visibleServerUpdate,
  type ServerUpdate,
} from "./serverUpdate.ts";

const NOW = Date.parse("2026-11-12T23:30:00.000Z");
const THREAD = "e5c358fe-c812-4726-ab78-4a66a2303b56";

const answer = (phase: string, extra: Record<string, unknown> = {}): ServerUpdate => {
  const parsed = parseServerUpdate({
    phase,
    version: "1.67.14",
    previousVersion: "1.67.13",
    updatedAt: "2026-11-12T23:29:50.000Z",
    waiting: null,
    ...extra,
  });
  if (parsed === null) throw new Error("not an answer");
  return parsed;
};

const shown = (update: ServerUpdate, reachable = true, answeredAtMs = NOW) =>
  visibleServerUpdate({
    update,
    answeredAtMs,
    reachable,
    nowMs: NOW,
    nameOfThread: (threadId) => (threadId === THREAD ? "Poteto in Hbots" : null),
  });

describe("the server update status", () => {
  it("names who the update waits for and for how long", () => {
    const waiting = {
      since: "2026-11-12T23:26:00.000Z",
      busyThreadIds: [THREAD, "not-a-thread"],
      buildRunning: false,
      quietLooks: 0,
    };
    expect(shown(answer("waiting_for_idle", { waiting }))).toEqual({
      title: "Update 1.67.14 is waiting for the bots to finish",
      detail: "Busy now: Poteto in Hbots. Waiting 4 min.",
      tone: "notice",
    });
  });

  it("says a build holds it, or that the restart is close, when no chat is busy", () => {
    const base = { since: "2026-11-12T23:29:30.000Z", busyThreadIds: [], quietLooks: 0 };
    expect(
      shown(answer("waiting_for_idle", { waiting: { ...base, buildRunning: true } }))?.detail,
    ).toBe("A build is running. Waiting under 1 min.");
    expect(
      shown(
        answer("waiting_for_idle", { waiting: { ...base, buildRunning: false, quietLooks: 2 } }),
      )?.detail,
    ).toBe("All quiet. Restarting shortly. Waiting under 1 min.");
  });

  it("does not name a chat it cannot resolve", () => {
    const waiting = {
      since: null,
      busyThreadIds: ["11111111-1111-1111-1111-111111111111"],
      buildRunning: false,
      quietLooks: 0,
    };
    expect(shown(answer("waiting_for_idle", { waiting }))?.detail).toBe("A bot is still working.");
  });

  it("says restarting while the server is away after a phase that leads to a restart", () => {
    const lines = shown(answer("waiting_for_idle"), false);
    expect(lines?.title).toBe("Restarting the server for the update");
    expect(shown(answer("activating"))?.detail).toBe("Back in about a minute.");
    // Away for longer than a restart takes: the calm line goes.
    expect(shown(answer("waiting_for_idle"), false, NOW - 6 * 60_000)).toBeNull();
    // No update was under way: being away is not a restart.
    expect(shown(answer("live_verified"), false)).toBeNull();
  });

  it("says checking, then updated for ten seconds on this device, then nothing", () => {
    expect(shown(answer("smoking"))?.title).toBe("Checking update 1.67.14");
    const updated = (updatedFirstShownMs: number | null) =>
      visibleServerUpdate({
        update: answer("live_verified"),
        answeredAtMs: NOW,
        reachable: true,
        nowMs: NOW,
        updatedFirstShownMs,
      });
    expect(updated(null)?.title).toBe("Updated to 1.67.14");
    expect(updated(NOW - 9_000)?.title).toBe("Updated to 1.67.14");
    expect(updated(NOW - 10_000)).toBeNull();
  });

  it("names the version still running after a rollback", () => {
    expect(shown(answer("rolled_back"))).toEqual({
      title: "Update failed, still on 1.67.13",
      detail: null,
      tone: "problem",
    });
  });

  it("asks often during an update and rarely otherwise", () => {
    expect(serverUpdatePollMs(answer("waiting_for_idle"), true)).toBe(10_000);
    expect(serverUpdatePollMs(answer("live_verified"), true)).toBe(60_000);
    expect(serverUpdatePollMs(null, true)).toBe(60_000);
    expect(serverUpdatePollMs(answer("activating"), false)).toBe(5_000);
  });
});
