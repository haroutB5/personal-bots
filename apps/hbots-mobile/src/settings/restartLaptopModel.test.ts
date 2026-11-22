import { describe, expect, it } from "vite-plus/test";

import {
  RESTART_HOLD_MS,
  RESTART_ROW_TITLE,
  RESTARTING_TEXT,
  canRestartLaptop,
  parseRestartStatus,
  restartHoldComplete,
  restartHoldProgress,
  restartOutcomeFromFailure,
  restartOutcomeFromResponse,
} from "./restartLaptopModel";
import { visibleSettingsSections } from "./settingsScreenModel";

describe("canRestartLaptop", () => {
  it("needs the owner's environment:maintain scope", () => {
    expect(canRestartLaptop("orchestration:read environment:maintain access:read")).toBe(true);
    expect(canRestartLaptop("orchestration:read orchestration:operate")).toBe(false);
    expect(canRestartLaptop("")).toBe(false);
  });
});

describe("restart hold", () => {
  it("fills over two seconds and completes only at the end", () => {
    expect(restartHoldProgress(0)).toBe(0);
    expect(restartHoldProgress(-5)).toBe(0);
    expect(restartHoldProgress(RESTART_HOLD_MS / 2)).toBe(0.5);
    expect(restartHoldComplete(RESTART_HOLD_MS - 1)).toBe(false);
    expect(restartHoldComplete(RESTART_HOLD_MS)).toBe(true);
    expect(restartHoldProgress(RESTART_HOLD_MS * 3)).toBe(1);
  });
});

describe("restartOutcomeFromResponse", () => {
  it("reads an accepted restart, dry run or not", () => {
    expect(restartOutcomeFromResponse(202, { ok: true, dryRun: false, rebootInMs: 1000 })).toEqual({
      kind: "restarting",
      dryRun: false,
    });
    expect(restartOutcomeFromResponse(202, { ok: true, dryRun: true })).toEqual({
      kind: "restarting",
      dryRun: true,
    });
  });

  it("shows the server's error text", () => {
    expect(
      restartOutcomeFromResponse(409, {
        ok: false,
        error: "logind refused: Call failed: Access denied",
      }),
    ).toEqual({ kind: "error", message: "logind refused: Call failed: Access denied" });
    expect(
      restartOutcomeFromResponse(429, { ok: false, error: "A restart was already asked for." }),
    ).toEqual({ kind: "error", message: "A restart was already asked for." });
  });

  it("falls back to a plain message when the body says nothing", () => {
    expect(restartOutcomeFromResponse(403, null)).toEqual({
      kind: "error",
      message: "Only the owner's phone can restart the laptop.",
    });
    expect(restartOutcomeFromResponse(500, "oops")).toEqual({
      kind: "error",
      message: "The server could not restart the laptop (HTTP 500).",
    });
    // A 2xx without ok:true is not taken as success.
    expect(restartOutcomeFromResponse(200, {}).kind).toBe("error");
  });

  it("explains a request that got no answer", () => {
    expect(restartOutcomeFromFailure({ name: "AbortError" }).kind).toBe("error");
    expect(restartOutcomeFromFailure(new TypeError("Network request failed"))).toEqual({
      kind: "error",
      message: "Couldn't reach the laptop. Check the connection and try again.",
    });
  });
});

describe("parseRestartStatus", () => {
  it("reads the status answer", () => {
    expect(
      parseRestartStatus(200, { ok: true, canReboot: true, dryRun: true, lastError: null }),
    ).toEqual({ canRestart: true, refusal: null, lastError: null, dryRun: true });
    expect(
      parseRestartStatus(200, {
        ok: true,
        canReboot: false,
        error: 'logind refused: CanReboot is "challenge"',
        dryRun: false,
        lastError: "logind refused the reboot: Access denied",
      }),
    ).toEqual({
      canRestart: false,
      refusal: 'logind refused: CanReboot is "challenge"',
      lastError: "logind refused the reboot: Access denied",
      dryRun: false,
    });
    expect(parseRestartStatus(401, { ok: false, error: "no" })).toBeNull();
  });
});

describe("the Settings row", () => {
  it("is found by search and hidden when the phone is not the owner's", () => {
    const found = visibleSettingsSections("reboot").flatMap((entry) =>
      entry.rows.map((row) => row.title),
    );
    expect(found).toEqual([RESTART_ROW_TITLE]);
    expect(visibleSettingsSections("reboot", new Set(["about.restartLaptop"]))).toEqual([]);
    expect(RESTARTING_TEXT).toBe(
      "Restarting. The app reconnects when the laptop is back (about 1-2 min).",
    );
  });
});
