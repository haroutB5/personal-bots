import { describe, expect, it } from "vite-plus/test";

import {
  gamingPcAriaLabel,
  gamingPcParts,
  gamingPcUsersText,
  machineStatRows,
  parseGamingPc,
  parseSystemSummary,
  systemPollDelayMs,
  type GamingPc,
} from "./systemStats.ts";

describe("parseSystemSummary", () => {
  it("fills the sensor fields from a new server", () => {
    expect(
      parseSystemSummary({
        cpuPct: 42,
        memUsedPct: 58,
        memUsedGB: 9.1,
        memTotalGB: 15.6,
        diskLabel: "C:",
        diskFreeGB: 120,
        diskTotalGB: 500,
        cpuTempC: 94,
        diskTempC: 38.9,
        fans: [
          { label: "CPU Fan", rpm: 2812 },
          { label: "Chassis Motherboard Fan", rpm: 2418 },
        ],
      }),
    ).toEqual({
      cpuPct: 42,
      memUsedPct: 58,
      memUsedGB: 9.1,
      memTotalGB: 15.6,
      diskLabel: "C:",
      diskFreeGB: 120,
      diskTotalGB: 500,
      cpuTempC: 94,
      diskTempC: 38.9,
      fans: [
        { label: "CPU Fan", rpm: 2812 },
        { label: "Chassis Motherboard Fan", rpm: 2418 },
      ],
      gamingPc: null,
    });
  });

  it("reads an old server as no sensors and no fans", () => {
    const parsed = parseSystemSummary({ cpuPct: 3, diskFreeGB: 20 });

    expect(parsed?.cpuTempC).toBeNull();
    expect(parsed?.diskTempC).toBeNull();
    expect(parsed?.fans).toEqual([]);
  });

  it("drops a fan with no label or no reading", () => {
    const parsed = parseSystemSummary({
      fans: [
        { label: "CPU Fan", rpm: 2812 },
        { label: "", rpm: 900 },
        { label: "Chassis", rpm: 0 },
        { label: "Broken" },
        null,
      ],
    });

    expect(parsed?.fans).toEqual([{ label: "CPU Fan", rpm: 2812 }]);
  });
});

describe("machineStatRows", () => {
  it("draws every sensor the host has, in card order", () => {
    const rows = machineStatRows({
      cpuPct: 42,
      memUsedPct: 58,
      memUsedGB: 9.1,
      memTotalGB: 15.6,
      diskLabel: "/",
      diskFreeGB: 120,
      diskTotalGB: 500,
      cpuTempC: 94,
      diskTempC: 38.9,
      fans: [
        { label: "CPU Fan", rpm: 2812 },
        { label: "Chassis Motherboard Fan", rpm: 2418 },
      ],
      gamingPc: null,
    });

    expect(rows).toEqual([
      { key: "cpu", label: "CPU", value: "42%" },
      { key: "memory", label: "Memory", value: "9.1 of 15.6 GB" },
      { key: "disk", label: "Disk", value: "120 GB free" },
      { key: "cpuTemp", label: "CPU temperature", value: "94 °C" },
      { key: "diskTemp", label: "Disk temperature", value: "39 °C" },
      { key: "fan:0", label: "CPU Fan", value: "2,812 rpm" },
      { key: "fan:1", label: "Chassis Motherboard Fan", value: "2,418 rpm" },
    ]);
  });

  it("hides temperature and fan rows on a host without those sensors", () => {
    const rows = machineStatRows({
      cpuPct: 7,
      memUsedPct: 20,
      memUsedGB: 3.1,
      memTotalGB: 15.6,
      diskLabel: null,
      diskFreeGB: null,
      diskTotalGB: null,
      cpuTempC: null,
      diskTempC: null,
      fans: [],
      gamingPc: null,
    });

    expect(rows).toEqual([
      { key: "cpu", label: "CPU", value: "7%" },
      { key: "memory", label: "Memory", value: "3.1 of 15.6 GB" },
    ]);
  });
});

const ON = {
  state: "on",
  cpuPct: 32,
  gpuPct: 4,
  memUsedGB: 10.5,
  memTotalGB: 15.8,
  memUsedPct: 66.6,
  ageMs: 1200,
  users: [],
};

describe("the gaming PC in the summary", () => {
  it("is null for the exact 1.67.9 server body", () => {
    const body = {
      cpuPct: 12,
      memUsedPct: 63,
      memUsedGB: 10.1,
      memTotalGB: 16,
      diskLabel: "/",
      diskFreeGB: 120.4,
      diskTotalGB: 951.6,
      cpuTempC: 61,
      diskTempC: 39,
      fans: [{ label: "CPU Fan", rpm: 2812 }],
    };
    const parsed = parseSystemSummary(body);
    expect(parsed?.gamingPc).toBeNull();
    expect(parsed?.cpuPct).toBe(12);
    expect(parsed?.fans).toEqual([{ label: "CPU Fan", rpm: 2812 }]);
  });

  it("reads starting, and an on reading with its percents rounded", () => {
    expect(parseGamingPc({ state: "starting" })).toEqual({ state: "starting" });
    expect(parseGamingPc(ON)).toEqual({
      state: "on",
      cpuPct: 32,
      gpuPct: 4,
      memUsedGB: 10.5,
      memTotalGB: 15.8,
      memUsedPct: 67,
      ageMs: 1200,
      users: [],
    });
    expect(parseSystemSummary({ cpuPct: 1, gamingPc: { state: "starting" } })?.gamingPc).toEqual({
      state: "starting",
    });
  });

  it("clamps percents and keeps a missing GPU as null", () => {
    expect(parseGamingPc({ ...ON, cpuPct: 140, memUsedPct: -3, gpuPct: null })).toMatchObject({
      cpuPct: 100,
      memUsedPct: 0,
      gpuPct: null,
    });
  });

  it.each([
    ["null", null],
    ["a string", "on"],
    ["an array", []],
    ["an unknown state", { ...ON, state: "waking" }],
    ["no cpu", { ...ON, cpuPct: undefined }],
    ["a string cpu", { ...ON, cpuPct: "32" }],
    ["NaN memory", { ...ON, memUsedGB: Number.NaN }],
    ["zero total memory", { ...ON, memTotalGB: 0 }],
    ["no used percent", { ...ON, memUsedPct: undefined }],
  ])("shows nothing for %s", (_name, raw) => {
    expect(parseGamingPc(raw)).toBeNull();
  });

  it("drops a malformed user and keeps the good ones", () => {
    const parsed = parseGamingPc({
      ...ON,
      users: [
        { kind: "game", game: "league-match", label: "League of Legends" },
        { kind: "game", game: "chess", label: "x" },
        { kind: "game", game: "other", label: "   " },
        { kind: "robot", bot: "R2" },
        { kind: "bot", bot: "", job: null, purpose: null },
        { kind: "bot", bot: "Builder", job: "teleport", purpose: "  hbots\u0007 motion  " },
        { kind: "bot", bot: "B".repeat(40), job: "emulator", purpose: "p".repeat(120) },
        "nope",
        null,
      ],
    });
    expect(parsed).toMatchObject({
      users: [
        { kind: "game", game: "league-match", label: "League of Legends" },
        { kind: "bot", bot: "Builder", job: null, purpose: "hbots motion" },
        { kind: "bot", bot: "B".repeat(24), job: "emulator", purpose: "p".repeat(80) },
      ],
    });
  });

  it("reads users that are not an array as none", () => {
    expect(parseGamingPc({ ...ON, users: "League" })).toMatchObject({ users: [] });
    expect(parseGamingPc({ ...ON, users: undefined })).toMatchObject({ users: [] });
  });
});

const onPc = (patch: Partial<Extract<GamingPc, { state: "on" }>> = {}): GamingPc => ({
  state: "on",
  cpuPct: 32,
  gpuPct: 4,
  memUsedGB: 12.2,
  memTotalGB: 15.8,
  memUsedPct: 77,
  ageMs: 0,
  users: [],
  ...patch,
});

describe("gamingPcParts", () => {
  it("reads Gaming PC, CPU, RAM as used/total GB, and GPU", () => {
    expect(gamingPcParts(onPc())).toEqual([
      { key: "label", text: "Gaming PC", busy: false },
      { key: "cpu", text: "CPU 32%", busy: false },
      { key: "ram", text: "RAM 12/16 GB", busy: false },
      { key: "gpu", text: "GPU 4%", busy: false },
    ]);
  });

  it("goes amber at 90 and not at 89, for each figure", () => {
    const busy = (pc: GamingPc) => gamingPcParts(pc).map((part) => part.busy);
    expect(busy(onPc({ cpuPct: 90 }))).toEqual([false, true, false, false]);
    expect(busy(onPc({ cpuPct: 89 }))).toEqual([false, false, false, false]);
    expect(busy(onPc({ memUsedPct: 90 }))).toEqual([false, false, true, false]);
    expect(busy(onPc({ memUsedPct: 89 }))).toEqual([false, false, false, false]);
    expect(busy(onPc({ gpuPct: 90 }))).toEqual([false, false, false, true]);
    expect(busy(onPc({ gpuPct: 89 }))).toEqual([false, false, false, false]);
  });

  it("drops the GPU part when there is no 3D engine reading", () => {
    expect(gamingPcParts(onPc({ gpuPct: null })).map((part) => part.text)).toEqual([
      "Gaming PC",
      "CPU 32%",
      "RAM 12/16 GB",
    ]);
  });

  it("shows no parts while starting or when absent", () => {
    expect(gamingPcParts({ state: "starting" })).toEqual([]);
    expect(gamingPcParts(null)).toEqual([]);
  });
});

describe("gamingPcUsersText", () => {
  it("is null with no users", () => {
    expect(gamingPcUsersText(onPc())).toBeNull();
    expect(gamingPcUsersText({ state: "starting" })).toBeNull();
    expect(gamingPcUsersText(null)).toBeNull();
  });

  it("joins a League match and a build in one line", () => {
    expect(
      gamingPcUsersText(
        onPc({
          users: [
            { kind: "game", game: "league-match", label: "League of Legends" },
            { kind: "bot", bot: "Builder", job: "build", purpose: "hbots motion throwaway APKs" },
          ],
        }),
      ),
    ).toBe("In use: League match, Builder (APK build)");
  });

  it("words each kind", () => {
    const text = (users: Extract<GamingPc, { state: "on" }>["users"]) =>
      gamingPcUsersText(onPc({ users }));
    expect(text([{ kind: "game", game: "league-open", label: "LeagueClient" }])).toBe(
      "In use: League open",
    );
    expect(text([{ kind: "game", game: "other", label: "VALORANT" }])).toBe("In use: VALORANT");
    expect(text([{ kind: "bot", bot: "Verifier", job: "emulator", purpose: null }])).toBe(
      "In use: Verifier (emulator)",
    );
    expect(text([{ kind: "bot", bot: "A bot", job: null, purpose: "x" }])).toBe("In use: A bot");
  });
});

describe("gamingPcAriaLabel", () => {
  it("reads the lines in words, with the purpose only here", () => {
    expect(
      gamingPcAriaLabel(
        onPc({
          memUsedGB: 12,
          memTotalGB: 16,
          users: [
            { kind: "bot", bot: "Builder", job: "build", purpose: "hbots motion throwaway APKs" },
          ],
        }),
      ),
    ).toBe(
      "Gaming PC: CPU 32 percent, memory 12 of 16 GB used, GPU 4 percent. In use by Builder for hbots motion throwaway APKs, APK build.",
    );
  });

  it("is short with nobody using it and no GPU reading", () => {
    expect(gamingPcAriaLabel(onPc({ gpuPct: null }))).toBe(
      "Gaming PC: CPU 32 percent, memory 12 of 16 GB used.",
    );
  });

  it("is null when there is nothing to say", () => {
    expect(gamingPcAriaLabel({ state: "starting" })).toBeNull();
    expect(gamingPcAriaLabel(null)).toBeNull();
  });
});

describe("systemPollDelayMs", () => {
  const base = parseSystemSummary({ cpuPct: 1 });
  it("asks again in 3 s while the gaming PC link is starting", () => {
    const starting = parseSystemSummary({ cpuPct: 1, gamingPc: { state: "starting" } });
    expect(systemPollDelayMs(starting, 10_000)).toBe(3_000);
  });
  it("keeps the normal delay otherwise", () => {
    expect(systemPollDelayMs(base, 10_000)).toBe(10_000);
    expect(systemPollDelayMs(null, 10_000)).toBe(10_000);
    expect(systemPollDelayMs(parseSystemSummary({ cpuPct: 1, gamingPc: ON }), 10_000)).toBe(10_000);
  });
  it("never lengthens a delay shorter than 3 s", () => {
    const starting = parseSystemSummary({ cpuPct: 1, gamingPc: { state: "starting" } });
    expect(systemPollDelayMs(starting, 1_000)).toBe(1_000);
  });
});
