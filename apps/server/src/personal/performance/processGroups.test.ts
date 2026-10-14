import { describe, expect, it } from "@effect/vitest";

import type { HelperChild, HelperParentRow, HelperProcessRow } from "./counterSample.ts";
import { groupProcesses, topGroups, type BotOwner } from "./processGroups.ts";

const SERVER = 15_000;

const row = (name: string, pid: number, cpuOneCore: number, memMB: number): HelperProcessRow => ({
  name,
  pid,
  cpuOneCore,
  memBytes: memMB * 1024 ** 2,
});

const child = (pid: number, name: string, cmd = ""): HelperChild => ({
  pid,
  name,
  cpu100ns: 0,
  wsBytes: 0,
  cmd,
});

/**
 * A recorded-style snapshot: the server with two bot CLIs (one with a shell
 * under it), the shared Chrome with a renderer, the tunnel, an app in the
 * user's session and service processes in session 0.
 */
const fixture = () => {
  const parents: HelperParentRow[] = [
    [SERVER, 100, 1],
    [20_001, SERVER, 1], // claude CLI for Atlas
    [20_002, 20_001, 1], // its shell command
    [20_003, SERVER, 1], // claude CLI for Forge
    [20_010, SERVER, 1], // Chrome (browser root)
    [20_011, 20_010, 1], // a renderer
    [20_050, SERVER, 1], // cloudflared
    [30_001, 500, 1], // the user's own Chrome
    [30_002, 500, 1],
    [40_001, 4, 0], // System
    [40_002, 900, 0], // a service
  ];
  const processes: HelperProcessRow[] = [
    row("_Total", 0, 350, 0),
    row("Idle", 0, 310, 0),
    row("node", SERVER, 20, 800),
    row("claude", 20_001, 40, 500),
    row("node", 20_002, 60, 100),
    row("claude", 20_003, 10, 300),
    row("chrome", 20_010, 5, 120),
    row("chrome", 20_011, 15, 200),
    row("cloudflared", 20_050, 1, 30),
    row("chrome", 30_001, 30, 900),
    row("chrome", 30_002, 10, 400),
    row("System", 40_001, 8, 50),
    row("svchost", 40_002, 4, 40),
    row("powershell", 20_099, 0.4, 60), // the counter helper: the server's own child
  ];
  parents.push([20_099, SERVER, 1]);
  const children = [
    child(20_001, "claude.exe", "claude.EXE --session-id=aaa"),
    child(20_003, "claude.exe", "claude.EXE --session-id=bbb"),
    child(20_010, "chrome.exe", "chrome.exe --user-data-dir=hbots"),
    child(20_050, "cloudflared.exe"),
    child(20_099, "powershell.exe", "-File perf-helper.ps1"),
  ];
  const attributed = new Map<number, BotOwner>([
    [20_001, { botId: "bot-atlas", name: "Atlas", provider: "claudeAgent" }],
    [20_003, { botId: "bot-forge", name: "Forge", provider: "codex" }],
  ]);
  return { parents, processes, children, attributed };
};

describe("groupProcesses", () => {
  it("groups bots by name, the browser, the server, Windows and other apps", () => {
    const { parents, processes, children, attributed } = fixture();
    const grouped = groupProcesses({
      processes,
      parents,
      children,
      attributed,
      serverPid: SERVER,
      logicalProcessors: 20,
    });

    const byName = new Map(grouped.groups.map((group) => [group.name, group]));
    // Atlas's tree includes its shell's CPU and memory.
    const atlas = byName.get("Atlas");
    expect(atlas?.kind).toBe("bot");
    expect(atlas?.botId).toBe("bot-atlas");
    expect(atlas?.provider).toBe("claudeAgent");
    expect(atlas?.processCount).toBe(2);
    expect(atlas?.cpuPct).toBe(5); // (40 + 60) / 20
    expect(atlas?.memGB).toBe(0.59); // 600 MB, rounded
    const forge = byName.get("Forge");
    expect(forge?.provider).toBe("codex");
    expect(forge?.processCount).toBe(1);
    expect(forge?.cpuPct).toBe(0.5);

    // The bots' browser is Chrome under the server, the user's Chrome is an app.
    expect(byName.get("Bots' browser")?.processCount).toBe(2);
    expect(byName.get("Bots' browser")?.cpuPct).toBe(1);
    expect(byName.get("Google Chrome")?.cpuPct).toBe(2);
    expect(byName.get("Google Chrome")?.processCount).toBe(2);
    // The helper and the tunnel count to the server, never to a bot.
    expect(byName.get("hbots server")?.processCount).toBe(3);
    expect(byName.get("hbots server")?.cpuPct).toBe(1.1); // node 20 + cloudflared 1 + powershell 0.4
    expect(byName.get("Windows")?.processCount).toBe(2);

    // Nothing leaked into the totals twice: the machine is fully accounted.
    const sum = grouped.groups.reduce((total, group) => total + group.cpuPct, 0);
    expect(sum).toBeCloseTo((20 + 40 + 60 + 10 + 5 + 15 + 1 + 0.4 + 30 + 10 + 8 + 4) / 20, 1);

    // The hbots table: server + bots + browser.
    expect(grouped.hbots.server.name).toBe("hbots server");
    expect(grouped.hbots.server.provider).toBeNull();
    expect(grouped.hbots.bots.provider).toBeNull();
    expect(grouped.hbots.bots.processCount).toBe(3);
    expect(grouped.hbots.bots.cpuPct).toBe(5.5);
    expect(grouped.hbots.total.cpuPct).toBe(7.6);
    expect(grouped.hbots.total.memGB).toBeCloseTo(
      (800 + 500 + 100 + 300 + 120 + 200 + 30 + 60) / 1024,
      2,
    );
  });

  it("keeps _Total, Idle and pid<=4 out entirely", () => {
    const { parents, processes, children, attributed } = fixture();
    const grouped = groupProcesses({
      processes: [...processes, row("weird", 2, 99, 99)],
      parents,
      children,
      attributed,
      serverPid: SERVER,
      logicalProcessors: 20,
    });
    const names = grouped.groups.map((group) => group.name);
    expect(names).not.toContain("_Total");
    expect(names).not.toContain("Idle");
    const sumAll = grouped.groups.reduce((total, group) => total + group.cpuPct, 0);
    expect(sumAll).toBeLessThan(13);
  });

  it("names no provider when one bot's tree spans two providers", () => {
    // A bot whose live chats run on two different providers must not be
    // labelled with either one: the row shows the count alone (QA, 14 Oct:
    // every bot row used to say "Claude Code").
    const { parents, processes, children } = fixture();
    const attributed = new Map<number, BotOwner>([
      [20_001, { botId: "bot-atlas", name: "Atlas", provider: "claudeAgent" }],
      [20_003, { botId: "bot-atlas", name: "Atlas", provider: "codex" }],
    ]);
    const grouped = groupProcesses({
      processes,
      parents,
      children,
      attributed,
      serverPid: SERVER,
      logicalProcessors: 20,
    });
    const atlas = grouped.groups.find((group) => group.name === "Atlas");
    expect(atlas?.provider).toBeNull();
    expect(atlas?.processCount).toBe(3); // the CLI, its shell, and the second provider's CLI
  });

  it("falls back to executable-name groups for a process the tree loses", () => {
    const { processes, children, attributed } = fixture();
    const grouped = groupProcesses({
      processes,
      parents: [], // a snapshot without parents groups only what it can
      children,
      attributed,
      serverPid: SERVER,
      logicalProcessors: 20,
    });
    expect(grouped.groups.some((group) => group.kind === "bot")).toBe(false);
    expect(grouped.groups.some((group) => group.name === "Claude Code")).toBe(true);
  });
});

describe("topGroups", () => {
  it("sorts by CPU and by memory separately", () => {
    const groups = [
      {
        name: "a",
        kind: "app" as const,
        botId: null,
        provider: null,
        processCount: 1,
        cpuPct: 2,
        memGB: 9,
      },
      {
        name: "b",
        kind: "app" as const,
        botId: null,
        provider: null,
        processCount: 1,
        cpuPct: 9,
        memGB: 2,
      },
      {
        name: "c",
        kind: "app" as const,
        botId: null,
        provider: null,
        processCount: 1,
        cpuPct: 5,
        memGB: 5,
      },
    ];
    const top = topGroups(groups, 2);
    expect(top.cpu.map((group) => group.name)).toEqual(["b", "c"]);
    expect(top.mem.map((group) => group.name)).toEqual(["a", "c"]);
  });
});
