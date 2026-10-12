import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  FINISHED_PHASE_WINDOW_MS,
  PROGRESS_PHASE_STALE_MS,
  RESTART_RESULT_MAX_AGE_MS,
  readRestartResult,
  restartResultVersion,
  restartStatusOf,
  updateStatusView,
} from "./updateStatus.ts";

const NOW = Date.parse("2026-10-12T21:00:00.000Z");
const ago = (ms: number) => NOW - ms;

const view = (input: {
  status: Parameters<typeof updateStatusView>[0]["status"];
  updatedAtMs: number;
  version?: string | null;
  liveVersion?: string | null;
}) =>
  updateStatusView({
    status: input.status,
    version: input.version ?? "1.66.34",
    liveVersion: input.liveVersion ?? "1.66.33",
    updatedAtMs: input.updatedAtMs,
    nowMs: NOW,
  });

describe("which files are a run's result", () => {
  it("matches only the plain restart result files", () => {
    expect(restartResultVersion("restart-1.66.34-result.json")).toBe("1.66.34");
    expect(restartResultVersion("restart-1.66.29-attempt1-result.json")).toBeNull();
    expect(restartResultVersion("restart-1.66.34-dryrun-result.json")).toBeNull();
    expect(restartResultVersion("restart-1.66.34-prepare-result.json")).toBeNull();
    expect(restartResultVersion("restart-1.66.34-guards-result.json")).toBeNull();
    expect(restartResultVersion("restart-1.66.34.pid")).toBeNull();
    expect(restartResultVersion("server.json")).toBeNull();
    expect(restartResultVersion("restart-1.66.34-result.json.bak")).toBeNull();
  });

  it("reads the runner's file, BOM and all", () => {
    const text = `﻿${JSON.stringify({
      runner: "hbots-release.ps1",
      mode: "run",
      status: "live_verified",
      version: "1.66.33",
      release: "970a9683d1aa",
    })}`;
    expect(readRestartResult(text)).toEqual({ status: "live_verified", version: "1.66.33" });
  });

  it("keeps a version from a file the runner did not sign, and drops a malformed one", () => {
    // Old waiters wrote these files without a `version` key; the name carries it.
    expect(readRestartResult(JSON.stringify({ status: "rolled_back" }))).toEqual({
      status: "rolled_back",
      version: null,
    });
    expect(
      readRestartResult(JSON.stringify({ status: "rolled_back", version: "not a version" })),
    ).toEqual({ status: "rolled_back", version: null });
  });

  it("shows nothing for bytes that are not a result at all", () => {
    expect(readRestartResult("not json")).toBeNull();
    expect(readRestartResult("[]")).toBeNull();
    expect(readRestartResult("null")).toBeNull();
    expect(restartStatusOf("from-the-future")).toBeNull();
    expect(restartStatusOf(7)).toBeNull();
    expect(restartStatusOf("smoking")).toBe("smoking");
  });
});

describe("which phases reach the page", () => {
  it("shows a run in progress while its file is fresh", () => {
    for (const status of [
      "starting",
      "guards",
      "notes_check",
      "evidence_check",
      "preflight",
      "backing_up",
      "activating",
      "smoking",
    ] as const) {
      expect(view({ status, updatedAtMs: ago(60_000) })?.phase).toBe(status);
    }
  });

  it("keeps waiting_for_idle for as long as the runner may wait (up to 48 h)", () => {
    expect(view({ status: "waiting_for_idle", updatedAtMs: ago(3 * 60 * 60_000) })?.phase).toBe(
      "waiting_for_idle",
    );
    expect(view({ status: "waiting_for_idle", updatedAtMs: ago(47 * 60 * 60_000) })?.phase).toBe(
      "waiting_for_idle",
    );
    expect(view({ status: "waiting_for_idle", updatedAtMs: ago(49 * 60 * 60_000) })).toBeNull();
  });

  it("forgets a progress phase whose file went quiet (a runner killed mid-run)", () => {
    expect(
      view({ status: "backing_up", updatedAtMs: ago(PROGRESS_PHASE_STALE_MS - 1) })?.phase,
    ).toBe("backing_up");
    expect(
      view({ status: "backing_up", updatedAtMs: ago(PROGRESS_PHASE_STALE_MS + 1) }),
    ).toBeNull();
  });

  it("shows a finished update for about ten minutes, then nothing", () => {
    for (const status of [
      "live_verified",
      "live_verified_doc_update_failed",
      "rolled_back",
      "rollback_failed",
      "failed",
      "rolling_back",
    ] as const) {
      expect(view({ status, updatedAtMs: ago(60_000) })?.phase).toBe(status);
      expect(view({ status, updatedAtMs: ago(FINISHED_PHASE_WINDOW_MS + 1) })).toBeNull();
    }
  });

  it("never shows a superseded waiter, and nothing at all past the file window", () => {
    expect(view({ status: "superseded_before_activation", updatedAtMs: ago(60_000) })).toBeNull();
    expect(view({ status: null, updatedAtMs: ago(60_000) })).toBeNull();
    expect(view({ status: "smoking", updatedAtMs: ago(RESTART_RESULT_MAX_AGE_MS + 1) })).toBeNull();
  });

  it("treats a file stamped in the future as just written", () => {
    expect(view({ status: "backing_up", updatedAtMs: NOW + 60_000 })?.phase).toBe("backing_up");
  });

  it("carries the version being applied, the version still live, and the phase time", () => {
    expect(view({ status: "smoking", updatedAtMs: ago(1_000) })).toEqual({
      phase: "smoking",
      version: "1.66.34",
      previousVersion: "1.66.33",
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(ago(1_000))),
    });
  });
});
