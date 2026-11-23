import { describe, expect, it } from "vite-plus/test";

import {
  RESTART_HOLD_MS,
  RESTART_ROW_TITLE,
  RESTARTING_TEXT,
  canRestartLaptop,
  parseRestartStatus,
  performRestartWithRescueFallback,
  restartHoldComplete,
  restartHoldProgress,
  restartOutcomeFromFailure,
  restartOutcomeFromResponse,
  shouldTryRescueReboot,
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

describe("shouldTryRescueReboot", () => {
  it("returns true for network/timeout, 5xx, and 409; false for 2xx, 401, 403, 429", () => {
    expect(shouldTryRescueReboot(null)).toBe(true);
    expect(shouldTryRescueReboot(500)).toBe(true);
    expect(shouldTryRescueReboot(502)).toBe(true);
    expect(shouldTryRescueReboot(503)).toBe(true);
    expect(shouldTryRescueReboot(409)).toBe(true);

    expect(shouldTryRescueReboot(200)).toBe(false);
    expect(shouldTryRescueReboot(202)).toBe(false);
    expect(shouldTryRescueReboot(401)).toBe(false);
    expect(shouldTryRescueReboot(403)).toBe(false);
    expect(shouldTryRescueReboot(429)).toBe(false);
  });
});

describe("performRestartWithRescueFallback", () => {
  const rescueConfig = { url: "https://rescue.example.com/reboot", token: "rescue-tok" };

  it("falls back to rescue on network error, 503, and 409", async () => {
    const called: string[] = [];
    const onNetwork = await performRestartWithRescueFallback({
      postPrimary: async () => {
        throw new TypeError("Network request failed");
      },
      loadRescue: async () => rescueConfig,
      postRescue: async (cfg) => {
        called.push(cfg.url);
        return { status: 202, body: { ok: true, dryRun: false } };
      },
    });
    expect(onNetwork).toEqual({ kind: "restarting", dryRun: false });
    expect(called).toEqual([rescueConfig.url]);

    const on409 = await performRestartWithRescueFallback({
      postPrimary: async () => ({ status: 409, body: { ok: false, error: "logind refused" } }),
      loadRescue: async () => rescueConfig,
      postRescue: async () => ({ status: 202, body: { ok: true, dryRun: true } }),
    });
    expect(on409).toEqual({ kind: "restarting", dryRun: true });
  });

  it("never falls back to rescue on 401, 403, or 429", async () => {
    let rescueCalled = false;
    for (const status of [401, 403, 429]) {
      const outcome = await performRestartWithRescueFallback({
        postPrimary: async () => ({ status, body: { ok: false, error: `err ${status}` } }),
        loadRescue: async () => rescueConfig,
        postRescue: async () => {
          rescueCalled = true;
          return { status: 202, body: { ok: true, dryRun: false } };
        },
      });
      expect(outcome).toEqual({ kind: "error", message: `err ${status}` });
    }
    expect(rescueCalled).toBe(false);
  });

  it("returns primary error when no rescue config is stored", async () => {
    const outcome = await performRestartWithRescueFallback({
      postPrimary: async () => ({ status: 503, body: { ok: false, error: "DB down" } }),
      loadRescue: async () => null,
      postRescue: async () => {
        throw new Error("should not run");
      },
    });
    expect(outcome).toEqual({ kind: "error", message: "DB down" });
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
  it("reads the status answer including transport and https rescue config", () => {
    expect(
      parseRestartStatus(200, {
        ok: true,
        canReboot: true,
        dryRun: true,
        lastError: null,
        transport: "rebootd",
        rescue: { url: "https://rescue.example.com/reboot", token: "secret-123" },
      }),
    ).toEqual({
      canRestart: true,
      refusal: null,
      lastError: null,
      dryRun: true,
      transport: "rebootd",
      rescue: { url: "https://rescue.example.com/reboot", token: "secret-123" },
    });

    // Rejects non-https rescue URL while keeping the rest of the status valid.
    expect(
      parseRestartStatus(200, {
        ok: true,
        canReboot: false,
        error: 'logind refused: CanReboot is "challenge"',
        dryRun: false,
        lastError: "logind refused the reboot: Access denied",
        rescue: { url: "http://insecure.example.com/reboot", token: "secret" },
      }),
    ).toEqual({
      canRestart: false,
      refusal: 'logind refused: CanReboot is "challenge"',
      lastError: "logind refused the reboot: Access denied",
      dryRun: false,
      transport: null,
      rescue: null,
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
