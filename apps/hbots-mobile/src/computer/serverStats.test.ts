import { describe, expect, it } from "vite-plus/test";

import {
  laptopSummary,
  parsePhoneSystemSummary,
  parseServerApps,
  parseServerStats,
  phonePollDelayMs,
  serverAppsParts,
  serverAppsText,
  serverAriaLabel,
  serverStatParts,
  type ServerApps,
} from "./serverStats";

const ON = {
  state: "on",
  cpuPct: 12,
  memUsedGB: 5.4,
  memTotalGB: 15.3,
  memUsedPct: 36,
  diskFreeGB: 238,
  diskTotalGB: 474.9,
  ageMs: 1200,
};
const ALL_UP = {
  state: "on",
  ageMs: 4000,
  appsUp: 8,
  appsTotal: 8,
  dbsUp: 1,
  dbsTotal: 1,
  problems: [],
};

const text = (parts: ReadonlyArray<{ text: string }>) => parts.map((p) => p.text).join(" · ");
const line = (apps: ServerApps | null) => text(serverAppsParts(apps));

describe("the server line", () => {
  it("reads 'Server · CPU 12% · RAM 5/15 GB · Disk 238 GB free'", () => {
    expect(text(serverStatParts(parseServerStats(ON)))).toBe(
      "Server · CPU 12% · RAM 5/15 GB · Disk 238 GB free",
    );
  });

  it("inks a busy CPU, full RAM and low disk amber", () => {
    const parts = serverStatParts(
      parseServerStats({ ...ON, cpuPct: 95, memUsedPct: 91, diskFreeGB: 20, diskTotalGB: 475 }),
    );
    expect(parts.filter((p) => p.busy).map((p) => p.key)).toEqual(["cpu", "ram", "disk"]);
  });

  it("leaves out a disk df could not read", () => {
    expect(text(serverStatParts(parseServerStats({ ...ON, diskFreeGB: null })))).toBe(
      "Server · CPU 12% · RAM 5/15 GB",
    );
  });

  it.each([
    ["starting", { state: "starting" }],
    ["absent", undefined],
    ["null", null],
    ["a broken reading", { state: "on", cpuPct: "x" }],
    ["zero memory", { ...ON, memTotalGB: 0 }],
    ["an unknown state", { state: "off" }],
  ])("is hidden when %s", (_name, raw) => {
    expect(serverStatParts(parseServerStats(raw))).toEqual([]);
  });
});

describe("the app health line", () => {
  it("reads 'Apps 8/8 up · DB ok' when everything is up", () => {
    const apps = parseServerApps(ALL_UP);
    expect(line(apps)).toBe("Apps 8/8 up · DB ok");
    expect(serverAppsParts(apps).some((p) => p.busy)).toBe(false);
  });

  it("names a down app and inks it amber", () => {
    const apps = parseServerApps({
      ...ALL_UP,
      appsUp: 7,
      problems: [{ kind: "app", name: "matchday", status: "down" }],
    });
    expect(line(apps)).toBe("Apps 7/8 up · matchday down · DB ok");
    expect(
      serverAppsParts(apps)
        .filter((p) => p.busy)
        .map((p) => p.key),
    ).toEqual(["apps", "appProblems"]);
  });

  it("names several problems and a database problem", () => {
    const apps = parseServerApps({
      ...ALL_UP,
      appsUp: 5,
      dbsUp: 0,
      problems: [
        { kind: "app", name: "matchday", status: "down" },
        { kind: "app", name: "rainhb", status: "unhealthy" },
        { kind: "app", name: "caltrack", status: "starting" },
        { kind: "db", name: "apps-postgres", status: "down" },
      ],
    });
    expect(line(apps)).toBe(
      "Apps 5/8 up · matchday down, rainhb unhealthy, caltrack starting · apps-postgres down",
    );
  });

  it("says 'DBs ok' for several databases and leaves DB out when there is none", () => {
    expect(line(parseServerApps({ ...ALL_UP, dbsUp: 2, dbsTotal: 2 }))).toBe(
      "Apps 8/8 up · DBs ok",
    );
    expect(line(parseServerApps({ ...ALL_UP, dbsUp: 0, dbsTotal: 0 }))).toBe("Apps 8/8 up");
  });

  it("puts the named problems first in the widget text so a cut keeps the name", () => {
    expect(serverAppsText(parseServerApps(ALL_UP))).toBe("Apps 8/8 up · DB ok");
    expect(
      serverAppsText(
        parseServerApps({
          ...ALL_UP,
          appsUp: 7,
          dbsUp: 0,
          problems: [
            { kind: "app", name: "matchday", status: "down" },
            { kind: "db", name: "apps-postgres", status: "down" },
          ],
        }),
      ),
    ).toBe("matchday down · apps-postgres down · Apps 7/8 up");
    expect(serverAppsText(parseServerApps({ state: "unreachable" }))).toBe("Coolify unreachable");
    expect(serverAppsText(parseServerApps({ state: "starting" }))).toBeNull();
  });

  it("says 'Coolify unreachable' in amber, never a count", () => {
    const apps = parseServerApps({ state: "unreachable" });
    expect(serverAppsParts(apps)).toEqual([
      { key: "unreachable", text: "Coolify unreachable", busy: true },
    ]);
  });

  it.each([
    ["starting", { state: "starting" }],
    ["absent", undefined],
    ["more up than total", { ...ALL_UP, appsUp: 9 }],
    ["a negative count", { ...ALL_UP, dbsTotal: -1 }],
    ["an unknown state", { state: "maybe" }],
  ])("is hidden when %s", (_name, raw) => {
    expect(serverAppsParts(parseServerApps(raw))).toEqual([]);
  });

  it("drops a problem with an unknown kind or status and cleans names", () => {
    const apps = parseServerApps({
      ...ALL_UP,
      problems: [
        { kind: "app", name: "ok\u0000name", status: "down" },
        { kind: "vm", name: "x", status: "down" },
        { kind: "app", name: "y", status: "on fire" },
        { kind: "app", name: "   ", status: "down" },
      ],
    }) as Extract<ServerApps, { state: "on" }>;
    expect(apps.problems).toEqual([{ kind: "app", name: "ok name", status: "down" }]);
  });
});

describe("the whole phone summary", () => {
  it("keeps the laptop fields, adds server and serverApps, and drops any gaming PC", () => {
    const summary = parsePhoneSystemSummary({
      cpuPct: 5,
      memUsedPct: 40,
      server: ON,
      serverApps: ALL_UP,
      gamingPc: { state: "on", cpuPct: 1, memUsedGB: 1, memTotalGB: 2, memUsedPct: 50 },
    })!;
    expect(summary.cpuPct).toBe(5);
    expect(summary.server).toMatchObject({ state: "on", cpuPct: 12 });
    expect(summary.serverApps).toMatchObject({ state: "on", appsUp: 8 });
    expect(summary).not.toHaveProperty("gamingPc");
    expect(laptopSummary(summary).gamingPc).toBeNull();
  });

  it("is null server parts from an older server that sends neither key", () => {
    const summary = parsePhoneSystemSummary({ cpuPct: 5 })!;
    expect(summary.server).toBeNull();
    expect(summary.serverApps).toBeNull();
    expect(serverAriaLabel(summary.server, summary.serverApps)).toBeNull();
  });

  it("speaks both lines", () => {
    expect(serverAriaLabel(parseServerStats(ON), parseServerApps(ALL_UP))).toBe(
      "Server: CPU 12 percent, memory 5 of 15 GB used, disk 238 GB free. Apps 8/8 up, DB ok.",
    );
  });

  it("polls after 3 s while a part is starting, else the normal delay", () => {
    const starting = parsePhoneSystemSummary({ cpuPct: 1, server: { state: "starting" } });
    expect(phonePollDelayMs(starting, 10_000)).toBe(3_000);
    const ready = parsePhoneSystemSummary({ cpuPct: 1, server: ON, serverApps: ALL_UP });
    expect(phonePollDelayMs(ready, 10_000)).toBe(10_000);
    expect(phonePollDelayMs(null, 10_000)).toBe(10_000);
  });
});
