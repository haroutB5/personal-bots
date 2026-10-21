import { describe, expect, it, vi } from "vite-plus/test";

import {
  SYSTEM_SUMMARY_URL,
  fetchSystemSummary,
  formatGB,
  parseSystemSummary,
  systemStatParts,
  systemStatsAriaLabel,
  type SystemSummary,
} from "./systemStats";

const summary = (overrides: Partial<SystemSummary> = {}): SystemSummary => ({
  cpuPct: 12,
  memUsedPct: 63,
  memUsedGB: 10.1,
  memTotalGB: 16,
  diskLabel: "C:",
  diskFreeGB: 120.4,
  diskTotalGB: 951.6,
  ...overrides,
});

describe("the PC line under the Bots header", () => {
  it("reads CPU, RAM and free disk in a few words", () => {
    expect(systemStatParts(summary()).map((part) => part.text)).toEqual([
      "CPU 12%",
      "RAM 63%",
      "C: 120 GB free",
    ]);
    expect(systemStatParts(summary()).some((part) => part.busy)).toBe(false);
  });

  it("inks a nearly full figure amber", () => {
    const parts = systemStatParts(summary({ cpuPct: 95, memUsedPct: 90, diskFreeGB: 40 }));
    expect(parts.map((part) => part.busy)).toEqual([true, true, true]);
  });

  it("leaves out a figure the server did not have", () => {
    expect(
      systemStatParts(summary({ cpuPct: null, diskFreeGB: null })).map((part) => part.text),
    ).toEqual(["RAM 63%"]);
    expect(systemStatParts(summary({ diskLabel: null }))[2]?.text).toBe("Disk 120 GB free");
  });

  it("formats sizes compactly", () => {
    expect(formatGB(8.46)).toBe("8.5 GB");
    expect(formatGB(120.4)).toBe("120 GB");
    expect(formatGB(1843)).toBe("1.8 TB");
  });

  it("says the whole line in words for screen readers", () => {
    expect(systemStatsAriaLabel(summary())).toBe(
      "PC: CPU 12 percent, memory 63 percent used, C: 120 GB free of 952 GB. Open Performance",
    );
  });

  it("parses only numbers and a short label", () => {
    expect(parseSystemSummary(null)).toBeNull();
    expect(
      parseSystemSummary({ cpuPct: "12", memUsedPct: 50, diskLabel: "x".repeat(40) }),
    ).toMatchObject({ cpuPct: null, memUsedPct: 50, diskLabel: null });
  });

  it("fetches without caching and gives null on a failed answer", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(summary())));
    expect(await fetchSystemSummary(ok as unknown as typeof fetch)).toEqual(summary());
    expect(ok).toHaveBeenCalledWith(
      SYSTEM_SUMMARY_URL,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    const denied = vi.fn(async () => new Response("no", { status: 401 }));
    expect(await fetchSystemSummary(denied as unknown as typeof fetch)).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await fetchSystemSummary(down as unknown as typeof fetch)).toBeNull();
  });
});
