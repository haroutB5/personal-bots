import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
  seedUsageLimits,
  shortProbeFailureReason,
} from "./providerUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("clears an earlier failed-refresh note once a live reading arrives, even unchanged", () => {
    const noted = { ...published, refreshFailed: { at: "2026-09-03T12:01:00.000Z" } };
    const next = applyUsageLimitsUpdate({
      previous: noted,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...weekly }] },
    });
    expect(next?.refreshFailed).toBeUndefined();
    expect(next?.windows).toEqual(published.windows);
    expect(next?.checkedAt).toBe("2026-09-03T12:00:05.000Z");
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
  const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
  const probeAt = "2026-09-03T12:05:00.000Z";

  it("keeps the last good windows through a failed probe and says the refresh failed", () => {
    const kept = resolveUsageLimitsAfterProbe({
      published,
      probed: failed,
      context: { checkedAt: probeAt, message: "Claude Agent CLI is installed but failed to run." },
    });
    // The reading keeps its own age; only the note is new.
    expect(kept).toEqual({
      ...published,
      refreshFailed: { at: probeAt, message: "Claude Agent CLI is installed but failed to run" },
    });
    expect(kept?.checkedAt).toBe(published.checkedAt);
    expect(kept?.unavailable).toBeUndefined();
  });

  it("keeps the reading when the probe carries no usage at all (CLI timed out before asking)", () => {
    // 7 Oct: the boot probe's `claude --version` timed out in a startup stall,
    // came back with usageLimits omitted, and used to wipe the seeded reading.
    const kept = resolveUsageLimitsAfterProbe({
      published,
      probed: undefined,
      context: {
        checkedAt: probeAt,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
        installed: true,
        enabled: true,
      },
    });
    expect(kept?.windows).toEqual(published.windows);
    expect(kept?.refreshFailed).toEqual({
      at: probeAt,
      message: "Claude Agent CLI is installed but failed to run",
    });
  });

  it("prefers the probe's own reason and never leaves the note without a time", () => {
    const named = resolveUsageLimitsAfterProbe({
      published,
      probed: { ...failed, unavailable: { reason: "probeFailed", message: "rate limited" } },
      context: { checkedAt: probeAt, message: "ignored" },
    });
    expect(named?.refreshFailed).toEqual({ at: probeAt, message: "rate limited" });
    const bare = resolveUsageLimitsAfterProbe({ published, probed: undefined });
    expect(bare?.refreshFailed).toEqual({ at: published.checkedAt });
  });

  it("keeps the reading when a probe reads no windows", () => {
    const kept = resolveUsageLimitsAfterProbe({
      published,
      probed: { checkedAt: probeAt, windows: [] },
      context: { checkedAt: probeAt },
    });
    expect(kept?.windows).toEqual(published.windows);
    expect(kept?.refreshFailed?.message).toBe("usage came back empty");
  });

  it("a probe that reads usage replaces the reading and its failure note", () => {
    const fresh = { checkedAt: probeAt, windows: [session] };
    const noted = { ...published, refreshFailed: { at: probeAt } };
    expect(resolveUsageLimitsAfterProbe({ published: noted, probed: fresh })).toBe(fresh);
  });

  it("lets authoritative answers replace the reading", () => {
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    // A disabled provider or a missing CLI has no usage to keep.
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        context: { checkedAt: probeAt, enabled: false },
      }),
    ).toBeUndefined();
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        context: { checkedAt: probeAt, installed: false },
      }),
    ).toBeUndefined();
  });

  it("has nothing to keep when nothing was ever read", () => {
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: undefined })).toBe(
      undefined,
    );
    expect(resolveUsageLimitsAfterProbe({ published: failed, probed: failed })).toBe(failed);
  });
});

describe("shortProbeFailureReason", () => {
  it("keeps the first sentence, trimmed and capped", () => {
    expect(shortProbeFailureReason("Timed out. Try again later.")).toBe("Timed out");
    expect(shortProbeFailureReason("  CLI 2.1.291 failed to start  ")).toBe(
      "CLI 2.1.291 failed to start",
    );
    expect(shortProbeFailureReason("x".repeat(300))?.length).toBe(120);
    expect(shortProbeFailureReason(undefined)).toBeUndefined();
    expect(shortProbeFailureReason("   ")).toBeUndefined();
  });
});

describe("seedUsageLimits", () => {
  const seed = { checkedAt: "2026-09-03T11:53:00.000Z", windows: [session, weekly] };
  const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
  const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };

  it("fills an empty slot or a failed probe with the seed, its own checkedAt intact", () => {
    expect(seedUsageLimits({ published: undefined, seed })).toBe(seed);
    expect(seedUsageLimits({ published: failed, seed })).toBe(seed);
    // After that it is simply the last good reading.
    expect(resolveUsageLimitsAfterProbe({ published: seed, probed: failed })?.windows).toBe(
      seed.windows,
    );
  });

  it("leaves a failure note from the previous run behind", () => {
    const noted = { ...seed, refreshFailed: { at: checkedAt, message: "old" } };
    expect(seedUsageLimits({ published: undefined, seed: noted })).toEqual(seed);
  });

  it("never displaces a reading the provider made itself", () => {
    expect(seedUsageLimits({ published, seed })).toBe(published);
    expect(seedUsageLimits({ published: unsupported, seed })).toBe(unsupported);
  });

  it("ignores a seed with nothing to show", () => {
    expect(seedUsageLimits({ published: undefined, seed: failed })).toBeUndefined();
    expect(seedUsageLimits({ published: failed, seed: { checkedAt, windows: [] } })).toBe(failed);
  });
});
