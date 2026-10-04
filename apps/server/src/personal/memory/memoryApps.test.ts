import { describe, expect, it } from "@effect/vitest";

import {
  APP_SCOPING_ENV,
  appScopingEnabled,
  appsToJson,
  detectActiveApps,
  formatAppIndex,
  MAX_ACTIVE_APPS,
  mentionsApp,
  normaliseApps,
  parseAppsJson,
  selectRules,
  type RuleLike,
} from "./memoryApps.ts";

const rule = (
  id: string,
  content: string,
  apps: ReadonlyArray<string> | null = null,
): RuleLike => ({
  memoryId: id,
  content,
  apps,
});

describe("scope matching", () => {
  it("treats hbots, personal-bots and the Bots app as one app", () => {
    for (const text of [
      "fix this in hbots",
      "the personal-bots repo",
      "the Personal Bots server",
      "in the Bots app",
      "HBOTS release",
    ]) {
      expect(mentionsApp(text, "personal-bots"), text).toBe(true);
    }
  });

  it("matches whole words only: sofamatch is not matchday, a robot is not hbots", () => {
    expect(mentionsApp("the sofamatch app", "matchday")).toBe(false);
    expect(mentionsApp("Matchday's average positions", "matchday")).toBe(true);
    expect(mentionsApp("matchdays are busy", "matchday")).toBe(false);
    expect(mentionsApp("robots and bots in general", "personal-bots")).toBe(false);
  });

  it("matches aliases with and without separators", () => {
    expect(mentionsApp("Cal Track macros", "caltrack")).toBe(true);
    expect(mentionsApp("IronFlow rest timer", "gymming-ironflow")).toBe(true);
    expect(mentionsApp("StringFit catalog", "tennisstringrec")).toBe(true);
    expect(mentionsApp("tennis poll payments", "tennis-poll")).toBe(true);
  });

  it("matches an unregistered app by its own slug", () => {
    expect(mentionsApp("the new gizmo-app needs a rule", "gizmo-app")).toBe(true);
    expect(mentionsApp("nothing here", "gizmo-app")).toBe(false);
  });

  it("normalises an app list: slugs, once each, empty is global", () => {
    expect(normaliseApps(["Matchday", " matchday ", "Personal Bots"])).toEqual([
      "matchday",
      "personal-bots",
    ]);
    expect(normaliseApps([])).toBeNull();
    expect(normaliseApps(["  ", "!!"])).toBeNull();
    expect(normaliseApps(null)).toBeNull();
    expect(appsToJson(["Matchday"])).toBe('["matchday"]');
    expect(appsToJson([])).toBeNull();
  });

  it("reads a damaged apps column as global, never as unreachable", () => {
    expect(parseAppsJson('["matchday"]')).toEqual(["matchday"]);
    expect(parseAppsJson("not json")).toBeNull();
    expect(parseAppsJson('{"a":1}')).toBeNull();
    expect(parseAppsJson(null)).toBeNull();
  });
});

describe("which apps a turn is about", () => {
  it("finds an app from the chat title, the message, recent turns and the bot's role", () => {
    const found = detectActiveApps({
      title: "matchday",
      current: "This works thx",
      recent: ["we were fixing CalTrack earlier"],
      botRole: "Tennis Coach\nHelps with tennis-poll bookings",
    });
    const bySlug = Object.fromEntries(found.map((app) => [app.slug, app.via]));
    expect(bySlug["matchday"]).toEqual(["title"]);
    expect(bySlug["caltrack"]).toEqual(["recent"]);
    expect(bySlug["tennis-poll"]).toEqual(["role"]);
  });

  it("puts the title and message first and caps the count", () => {
    const found = detectActiveApps({
      current: "compare matchday with rainhb",
      recent: ["caltrack", "homegym", "coachbuild", "sofamatch"],
    });
    expect(found.length).toBeLessThanOrEqual(MAX_ACTIVE_APPS);
    expect(
      found
        .slice(0, 2)
        .map((app) => app.slug)
        .toSorted(),
    ).toEqual(["matchday", "rainhb"]);
  });

  it("reads only the last few turns, each bounded", () => {
    const old = detectActiveApps({
      current: "ok",
      recent: ["a", "b", "c", "d", "matchday was long ago"],
    });
    expect(old).toEqual([]);
    const longTail = detectActiveApps({
      current: "ok",
      recent: [`${"x ".repeat(1_000)} matchday`],
    });
    expect(longTail).toEqual([]);
  });

  it("includes an app only rules know about", () => {
    const found = detectActiveApps({ current: "update the gizmo-app rules" }, ["gizmo-app"]);
    expect(found.map((app) => app.slug)).toEqual(["gizmo-app"]);
  });

  it("finds nothing for a message about no app", () => {
    expect(detectActiveApps({ current: "What is the weather in Lisbon?" })).toEqual([]);
  });
});

describe("a turn's rules", () => {
  const caps = { maxEntries: 60, maxChars: 15_000 };

  it("lists global rules and the active app's rules, and indexes the rest", () => {
    const rules = [
      rule("g1", "Global one."),
      rule("m1", "Matchday rule one.", ["matchday"]),
      rule("m2", "Matchday rule two.", ["matchday"]),
      rule("c1", "CalTrack rule.", ["caltrack"]),
      rule("h1", "hbots rule.", ["personal-bots"]),
    ];
    const picked = selectRules(rules, { active: new Set(["matchday"]), caps, scoping: true });
    expect(picked.kept.map((r) => r.memoryId)).toEqual(["g1", "m1", "m2"]);
    expect(picked.indexed.map((r) => r.memoryId)).toEqual(["c1", "h1"]);
    expect(picked.leftOut).toEqual([]);
    expect(formatAppIndex(picked.index)).toBe("CalTrack: 1 rule, hbots: 1 rule");
  });

  it("builds the one-line index with counts, biggest group first", () => {
    const rules = [
      rule("m1", "M1.", ["matchday"]),
      rule("m2", "M2.", ["matchday"]),
      rule("m3", "M3.", ["matchday"]),
      rule("c1", "C1.", ["caltrack"]),
    ];
    const picked = selectRules(rules, { active: new Set(), caps, scoping: true });
    expect(picked.kept).toEqual([]);
    expect(formatAppIndex(picked.index)).toBe("Matchday: 3 rules, CalTrack: 1 rule");
    expect(formatAppIndex([])).toBeNull();
  });

  it("counts a rule for two apps under both", () => {
    const picked = selectRules([rule("x", "Both.", ["matchday", "caltrack"])], {
      active: new Set(),
      caps,
      scoping: true,
    });
    expect(formatAppIndex(picked.index)).toBe("CalTrack: 1 rule, Matchday: 1 rule");
  });

  it("never drops a global rule, even when the caps are exceeded", () => {
    const big = "x".repeat(1_900);
    const globals = Array.from({ length: 10 }, (_, i) => rule(`g${i}`, `Global ${i} ${big}`));
    const scoped = rule("m1", `Matchday ${big}`, ["matchday"]);
    const picked = selectRules([scoped, ...globals], {
      active: new Set(["matchday"]),
      caps,
      scoping: true,
    });
    expect(picked.kept.map((r) => r.memoryId).filter((id) => id.startsWith("g"))).toHaveLength(10);
    // The scoped rule is the one that does not fit, and it is named.
    expect(picked.leftOut.map((r) => r.memoryId)).toEqual(["m1"]);
    expect(picked.fill.chars).toBeGreaterThan(1);
  });

  it("when an active app's rules do not fit, the oldest go and exactly those are reported", () => {
    const big = "y".repeat(2_000);
    // Newest first, as the service reads them.
    const rules = [
      ...Array.from({ length: 9 }, (_, i) => rule(`new${i}`, `Newer ${i} ${big}`, ["matchday"])),
      rule("short-old", "Short old.", ["matchday"]),
    ];
    const picked = selectRules(rules, { active: new Set(["matchday"]), caps, scoping: true });
    // 7 x ~2,010 fit under 15,000; the 8th does not, and no shorter older rule jumps the queue.
    expect(picked.kept).toHaveLength(7);
    expect(picked.leftOut.map((r) => r.memoryId)).toEqual(["new7", "new8", "short-old"]);
  });

  it("reports left-out rules by count too", () => {
    const rules = Array.from({ length: 65 }, (_, i) => rule(`r${i}`, `Rule ${i}.`, ["matchday"]));
    const picked = selectRules(rules, { active: new Set(["matchday"]), caps, scoping: true });
    expect(picked.kept).toHaveLength(60);
    expect(picked.leftOut).toHaveLength(5);
    expect(picked.leftOut[0]!.memoryId).toBe("r60");
  });

  it("with scoping off every rule is global", () => {
    const rules = [rule("g", "Global."), rule("m", "Matchday.", ["matchday"])];
    const picked = selectRules(rules, { active: new Set(), caps, scoping: false });
    expect(picked.kept.map((r) => r.memoryId)).toEqual(["g", "m"]);
    expect(picked.index).toEqual([]);
  });

  it("lists the same text once", () => {
    const rules = [rule("a", "Same rule."), rule("b", "  same   RULE. ")];
    const picked = selectRules(rules, { active: new Set(), caps, scoping: true });
    expect(picked.kept.map((r) => r.memoryId)).toEqual(["a"]);
  });

  it("reads the kill switch", () => {
    expect(appScopingEnabled({})).toBe(true);
    expect(appScopingEnabled({ [APP_SCOPING_ENV]: "off" })).toBe(false);
    expect(appScopingEnabled({ [APP_SCOPING_ENV]: "OFF " })).toBe(false);
    expect(appScopingEnabled({ [APP_SCOPING_ENV]: "on" })).toBe(true);
  });
});
