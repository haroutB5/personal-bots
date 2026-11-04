import { describe, expect, it } from "vitest";

import { planInAppNotifications } from "@hbots/personal-client/bots/inAppNotifications";
import { offlineBannerHint, offlineBannerText } from "@hbots/personal-client/bots/offlineBanner";
import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import {
  selectUsageStripCells,
  stripCellBarPercent,
} from "@hbots/personal-client/usage/usageStrip";
import type { UsageCard, UsageWindowRow } from "@hbots/personal-client/usage/usagePresentation";

function row(id: string, usedPercent: number): UsageWindowRow {
  return { id, label: id, usedPercent, resetLabel: null, resetTimeLabel: null };
}

function card(driver: UsageCard["driver"], session: number, weekly: number | null): UsageCard {
  return {
    driver,
    title: "Claude",
    plan: "Max",
    status: "ready",
    notice: null,
    refreshFailure: null,
    session: row("session", session),
    weeklies: weekly === null ? [] : [row("weekly", weekly)],
    checkedAt: null,
    resetCredits: null,
    balance: null,
  };
}

describe("Bots home view model", () => {
  it("formats list times as the web does", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(formatRelativeTime(now - 20_000, now)).toBe("Now");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3m");
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2h");
    expect(formatRelativeTime(Date.parse("2026-11-03T09:00:00Z"), now)).toBe("Yesterday");
    expect(formatRelativeTime(Date.parse("2026-09-12T09:00:00Z"), now)).toBe("12 Sep");
  });

  it("writes the offline banner with the last contact", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(offlineBannerText("connected", now - 60_000, now)).toBeNull();
    expect(offlineBannerText("offline", null, now)).toBe("Laptop offline");
    expect(offlineBannerText("offline", now - 5 * 60_000, now)).toBe(
      "Laptop offline · last contact 5m ago",
    );
    expect(offlineBannerHint(0)).toBe("Messages you send will go out when it reconnects.");
    expect(offlineBannerHint(2)).toBe(
      "2 messages are waiting to send. They go out when it reconnects.",
    );
  });

  it("acknowledges fresh in-app notifications and hides the screen's own", () => {
    const seen = new Set<string>();
    const feed = [
      {
        id: "n1",
        title: "Assistant replied",
        body: "Done",
        url: "/bots/a/1",
        quietPath: "/bots/a/1",
      },
      { id: "n2", title: "Planner replied", body: "Ready", url: "/bots/p/2" },
    ];
    expect(planInAppNotifications(seen, feed, { visible: false, currentPath: "/bots" })).toEqual({
      ack: [],
      show: null,
    });
    expect(planInAppNotifications(seen, feed, { visible: true, currentPath: "/bots" })).toEqual({
      ack: ["n1", "n2"],
      show: feed[1],
    });
    expect(planInAppNotifications(seen, feed, { visible: true, currentPath: "/bots" })).toEqual({
      ack: [],
      show: null,
    });
  });

  it("fills the usage bar to the worse window", () => {
    const cells = selectUsageStripCells([card("claudeAgent", 10, 64)]);
    expect(cells).toEqual([
      { driver: "claudeAgent", title: "Claude", sessionPercent: 10, weeklyPercent: 64 },
    ]);
    expect(stripCellBarPercent(cells[0]!)).toBe(64);
    expect(selectUsageStripCells([card("deepseek", 0, null)])).toEqual([]);
  });
});
