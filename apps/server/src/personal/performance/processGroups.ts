/**
 * Turns the raw process snapshot into the groups the Performance tab shows:
 * each bot by name (its provider CLI tree), the bots' own Chrome, the hbots
 * server, Windows (session 0) and other apps by executable name.
 *
 * Pure on purpose: the tests hand it recorded snapshots, and the browser
 * root rule matches `personal/browser/browserPriority.ts` (image-named
 * children of the server), so a bot's own Chrome is never mistaken for the
 * shared one.
 */
import type { PerformanceGroup, PerformanceGroupKind } from "@t3tools/contracts";

import type { HelperChild, HelperParentRow, HelperProcessRow } from "./counterSample.ts";

const CHROME_IMAGE = /^(chrome|msedge|chromium|chrome-headless-shell)$/i;

/** `\Process(*)\% Processor Time` includes these; they are not processes. */
const NON_PROCESS = new Set(["_total", "idle"]);

export interface BotOwner {
  readonly botId: string;
  readonly name: string;
}

export interface GroupInput {
  readonly processes: ReadonlyArray<HelperProcessRow>;
  readonly parents: ReadonlyArray<HelperParentRow>;
  /** The server's direct children, with their command lines. */
  readonly children: ReadonlyArray<HelperChild>;
  /** pid -> bot for every provider CLI this server spawned, by its session id. */
  readonly attributed: ReadonlyMap<number, BotOwner>;
  readonly serverPid: number;
  readonly logicalProcessors: number;
}

export interface GroupedProcesses {
  readonly groups: ReadonlyArray<PerformanceGroup>;
  readonly hbots: {
    readonly server: PerformanceGroup;
    readonly bots: PerformanceGroup;
    readonly browser: PerformanceGroup;
    readonly total: PerformanceGroup;
  };
}

const prettyAppName = (image: string): string => {
  const base = image.replace(/\.exe$/i, "");
  if (base === "") return image;
  const known: Record<string, string> = {
    chrome: "Google Chrome",
    msedge: "Microsoft Edge",
    node: "Node.js",
    powershell: "PowerShell",
    pwsh: "PowerShell",
    svchost: "Windows services",
    teams: "Microsoft Teams",
    "ms-teams": "Microsoft Teams",
    explorer: "Windows Explorer",
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
  };
  const hit = known[base.toLowerCase()];
  if (hit !== undefined) return hit;
  return base.charAt(0).toUpperCase() + base.slice(1);
};

interface Accumulator {
  name: string;
  kind: PerformanceGroupKind;
  botId: string | null;
  processCount: number;
  cpuPct: number;
  memGB: number;
}

/**
 * Which tree a pid belongs to: the server's own (its children like the tunnel
 * and the counter helper included), a bot's provider tree, the bots' browser,
 * or none. Walks up the parent chain; a cycle (a corrupted snapshot) answers
 * none rather than looping.
 */
export function treeOf(
  pid: number,
  input: {
    readonly parentOf: ReadonlyMap<number, number>;
    readonly owners: ReadonlyMap<number, BotOwner>;
    readonly browserRoots: ReadonlySet<number>;
    readonly serverPid: number;
  },
): "server" | "browser" | BotOwner | null {
  let current = pid;
  const seen = new Set<number>();
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    if (current === input.serverPid) return "server";
    if (input.browserRoots.has(current)) return "browser";
    const owner = input.owners.get(current);
    if (owner !== undefined) return owner;
    const up = input.parentOf.get(current);
    if (up === undefined || up === current || up <= 4) return null;
    current = up;
  }
}

/**
 * The bot owning each process: one of the server's children whose command
 * line names a session the server knows (`attributed`), or any descendant of
 * one. A bot's shell commands therefore count to that bot.
 */
export function attributeTree(
  parents: ReadonlyArray<HelperParentRow>,
  attributedRoots: ReadonlyMap<number, BotOwner>,
  serverPid: number,
): Map<number, BotOwner> {
  const parentOf = new Map<number, number>();
  for (const [pid, parent] of parents) parentOf.set(pid, parent);
  const owners = new Map<number, BotOwner>();
  const resolve = (pid: number): BotOwner | undefined => {
    let current = pid;
    const seen = new Set<number>();
    while (true) {
      const known = owners.get(current);
      if (known !== undefined) return known;
      const direct = attributedRoots.get(current);
      if (direct !== undefined) return direct;
      if (seen.has(current)) return undefined;
      seen.add(current);
      const up = parentOf.get(current);
      if (up === undefined || up === current || up <= 4 || up === serverPid) return undefined;
      current = up;
    }
  };
  for (const [pid] of parentOf) {
    const owner = resolve(pid);
    if (owner !== undefined) owners.set(pid, owner);
  }
  return owners;
}

export function groupProcesses(input: GroupInput): GroupedProcesses {
  const divisor = input.logicalProcessors > 0 ? input.logicalProcessors : 1;
  const parentOf = new Map<number, number>();
  const sessionOf = new Map<number, number>();
  for (const [pid, parent, session] of input.parents) {
    parentOf.set(pid, parent);
    sessionOf.set(pid, session);
  }
  const owners = attributeTree(input.parents, input.attributed, input.serverPid);
  const browserRoots = new Set<number>();
  for (const child of input.children) {
    if (CHROME_IMAGE.test(child.name.replace(/\.exe$/i, ""))) browserRoots.add(child.pid);
  }

  const byBot = new Map<string, Accumulator>();
  const byApp = new Map<string, Accumulator>();
  const serverAcc: Accumulator = {
    name: "hbots server",
    kind: "hbots",
    botId: null,
    processCount: 0,
    cpuPct: 0,
    memGB: 0,
  };
  const browserAcc: Accumulator = {
    name: "Bots' browser",
    kind: "hbots",
    botId: null,
    processCount: 0,
    cpuPct: 0,
    memGB: 0,
  };
  const windowsAcc: Accumulator = {
    name: "Windows",
    kind: "system",
    botId: null,
    processCount: 0,
    cpuPct: 0,
    memGB: 0,
  };

  const add = (acc: Accumulator, row: HelperProcessRow): void => {
    acc.processCount += 1;
    acc.cpuPct += row.cpuOneCore / divisor;
    acc.memGB += row.memBytes / 1024 ** 3;
  };
  const fresh = (name: string, kind: PerformanceGroupKind, botId: string | null): Accumulator => ({
    name,
    kind,
    botId,
    processCount: 0,
    cpuPct: 0,
    memGB: 0,
  });
  const botAcc = (owner: BotOwner): Accumulator => {
    const existing = byBot.get(owner.botId);
    if (existing !== undefined) return existing;
    const created = fresh(owner.name, "bot", owner.botId);
    byBot.set(owner.botId, created);
    return created;
  };

  for (const row of input.processes) {
    if (NON_PROCESS.has(row.name.toLowerCase()) || row.pid <= 4) continue;
    const tree = treeOf(row.pid, {
      parentOf,
      owners,
      browserRoots,
      serverPid: input.serverPid,
    });
    if (tree === "server") {
      add(serverAcc, row);
      continue;
    }
    if (tree === "browser") {
      add(browserAcc, row);
      continue;
    }
    if (tree !== null) {
      add(botAcc(tree), row);
      continue;
    }
    if (sessionOf.get(row.pid) === 0) {
      add(windowsAcc, row);
      continue;
    }
    const key = row.name.toLowerCase();
    const existing = byApp.get(key);
    if (existing !== undefined) {
      add(existing, row);
      continue;
    }
    const created = fresh(prettyAppName(row.name), "app", null);
    byApp.set(key, created);
    add(created, row);
  }

  const finish = (acc: Accumulator): PerformanceGroup => ({
    name: acc.name,
    kind: acc.kind,
    botId: acc.botId,
    processCount: acc.processCount,
    cpuPct: Math.round(acc.cpuPct * 10) / 10,
    memGB: Math.round(acc.memGB * 100) / 100,
  });

  const groups: PerformanceGroup[] = [];
  for (const acc of byBot.values()) groups.push(finish(acc));
  for (const acc of byApp.values()) groups.push(finish(acc));
  if (windowsAcc.processCount > 0) groups.push(finish(windowsAcc));
  groups.push(finish(serverAcc));
  if (browserAcc.processCount > 0) groups.push(finish(browserAcc));

  const botsTotal = fresh("Bots", "hbots", null);
  for (const acc of byBot.values()) {
    botsTotal.processCount += acc.processCount;
    botsTotal.cpuPct += acc.cpuPct;
    botsTotal.memGB += acc.memGB;
  }
  const serverGroup = finish(serverAcc);
  const botsGroup = finish(botsTotal);
  const browserGroup = finish(browserAcc);
  const total: PerformanceGroup = {
    name: "Total",
    kind: "hbots",
    botId: null,
    processCount: serverGroup.processCount + botsGroup.processCount + browserGroup.processCount,
    cpuPct: Math.round((serverGroup.cpuPct + botsGroup.cpuPct + browserGroup.cpuPct) * 10) / 10,
    memGB: Math.round((serverGroup.memGB + botsGroup.memGB + browserGroup.memGB) * 100) / 100,
  };

  return {
    groups,
    hbots: { server: serverGroup, bots: botsGroup, browser: browserGroup, total },
  };
}

/** The top N groups by CPU and by memory, as the screen shows them. */
export function topGroups(
  groups: ReadonlyArray<PerformanceGroup>,
  n: number,
): {
  readonly cpu: ReadonlyArray<PerformanceGroup>;
  readonly mem: ReadonlyArray<PerformanceGroup>;
} {
  const cpu = [...groups].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, n);
  const mem = [...groups].sort((a, b) => b.memGB - a.memGB).slice(0, n);
  return { cpu, mem };
}
