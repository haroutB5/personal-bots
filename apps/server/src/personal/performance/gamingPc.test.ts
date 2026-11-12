// @effect-diagnostics nodeBuiltinImport:off - the rig fixture needs a real directory tree.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  GAMING_PC_STALE_MS,
  PC_REMOTE_COMMAND,
  PC_SSH_ARGS,
  parseGamingPcConfig,
  parsePcLine,
  readRigHolder,
  makeGamingPcReader,
  type GamingPcReader,
  type LinkHandle,
  type RigHolder,
} from "./gamingPc.ts";
import { PC_STATS_SCRIPT } from "./gamingPcScript.ts";

const IDLE_LINE = '{"v":1,"cpuPct":29,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":null}';
const MATCH_LINE =
  '{"v":1,"cpuPct":41,"memAvailMb":3100,"memTotalMb":16161,"gpuPct":62,"game":{"kind":"match","process":"League of Legends"}}';

describe("parseGamingPcConfig", () => {
  it("is off with no warning when the host is unset or empty", () => {
    expect(parseGamingPcConfig({})).toEqual({ config: null, warning: null });
    expect(parseGamingPcConfig({ T3CODE_PERSONAL_GAMINGPC_HOST: "  " })).toEqual({
      config: null,
      warning: null,
    });
  });

  it("accepts a plain ssh alias and an optional rig directory", () => {
    expect(
      parseGamingPcConfig({
        T3CODE_PERSONAL_GAMINGPC_HOST: "gamingpc",
        T3CODE_PERSONAL_GAMINGPC_RIG_DIR: "/home/harout/.cache/hbots-rig",
      }),
    ).toEqual({
      config: { host: "gamingpc", rigDir: "/home/harout/.cache/hbots-rig" },
      warning: null,
    });
    expect(parseGamingPcConfig({ T3CODE_PERSONAL_GAMINGPC_HOST: "pc-1.lan" }).config).toEqual({
      host: "pc-1.lan",
      rigDir: null,
    });
  });

  it.each([
    "-oProxyCommand=evil",
    "-F/etc/passwd",
    "host name",
    "user@host",
    "host;rm",
    "$(id)",
    ".hidden",
    "a".repeat(64),
    "gamingpc\n-v",
  ])("rejects %j as not a plain ssh host alias", (host) => {
    expect(parseGamingPcConfig({ T3CODE_PERSONAL_GAMINGPC_HOST: host })).toEqual({
      config: null,
      warning: "gaming PC stats off: T3CODE_PERSONAL_GAMINGPC_HOST is not a plain ssh host alias",
    });
  });
});

describe("the fixed ssh command", () => {
  it("never reads a request, client or environment value", () => {
    expect(PC_SSH_ARGS).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
    ]);
    expect(PC_REMOTE_COMMAND).toBe("$s = [Console]::In.ReadToEnd(); Invoke-Expression $s");
  });

  it("sends a script that only reads on the PC and ends by itself", () => {
    expect(PC_STATS_SCRIPT).toContain("$MaxLines = 24");
    expect(PC_STATS_SCRIPT).toContain("if ($n -ge $MaxLines) { exit 0 }");
    for (const writer of [
      "Set-Content",
      "Add-Content",
      "Out-File",
      "New-Item",
      "Remove-Item",
      "Stop-Process",
      "Start-Process",
      "Set-ItemProperty",
      "Restart-",
      "Install-",
      "netsh",
      "powercfg",
      "Invoke-WebRequest",
      "taskkill",
    ]) {
      expect(PC_STATS_SCRIPT).not.toContain(writer);
    }
    const paths = PC_STATS_SCRIPT.match(/[A-Za-z]:\\[^'"\s)]*/g) ?? [];
    expect([...new Set(paths)].toSorted()).toEqual([
      String.raw`S:\hbots\games.txt`,
      String.raw`S:\hbots\light-games.txt`,
    ]);
  });
});

describe("parsePcLine", () => {
  it("parses the idle line", () => {
    expect(parsePcLine(IDLE_LINE)).toEqual({
      cpuPct: 29,
      memAvailMb: 5398,
      memTotalMb: 16161,
      gpuPct: 0,
      game: null,
    });
  });

  it("parses a line with a League match", () => {
    expect(parsePcLine(MATCH_LINE)).toEqual({
      cpuPct: 41,
      memAvailMb: 3100,
      memTotalMb: 16161,
      gpuPct: 62,
      game: { kind: "match", process: "League of Legends" },
    });
  });

  it("keeps a missing GPU counter as null", () => {
    expect(
      parsePcLine(
        '{"v":1,"cpuPct":3,"memAvailMb":9000,"memTotalMb":16161,"gpuPct":null,"game":null}',
      )?.gpuPct,
    ).toBeNull();
  });

  it.each([
    [
      "version 2",
      '{"v":2,"cpuPct":29,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":null}',
    ],
    [
      "negative cpu",
      '{"v":1,"cpuPct":-1,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":null}',
    ],
    [
      "null cpu",
      '{"v":1,"cpuPct":null,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":null}',
    ],
    [
      "string cpu",
      '{"v":1,"cpuPct":"29","memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":null}',
    ],
    [
      "negative free memory",
      '{"v":1,"cpuPct":29,"memAvailMb":-5,"memTotalMb":16161,"gpuPct":0,"game":null}',
    ],
    [
      "zero total memory",
      '{"v":1,"cpuPct":29,"memAvailMb":5398,"memTotalMb":0,"gpuPct":0,"game":null}',
    ],
    [
      "negative gpu",
      '{"v":1,"cpuPct":29,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":-3,"game":null}',
    ],
    [
      "unknown game kind",
      '{"v":1,"cpuPct":29,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":{"kind":"boss","process":"x"}}',
    ],
    [
      "empty game process",
      '{"v":1,"cpuPct":29,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":{"kind":"game","process":""}}',
    ],
    ["broken json", '{"v":1,"cpuPct":29,'],
    ["an array", "[1,2,3]"],
    ["a banner line", "Warning: Permanently added host"],
    ["empty", ""],
  ])("rejects %s", (_name, line) => {
    expect(parsePcLine(line)).toBeNull();
  });

  it("clamps a CPU reading above 100", () => {
    expect(
      parsePcLine(
        '{"v":1,"cpuPct":125,"memAvailMb":5398,"memTotalMb":16161,"gpuPct":0,"game":null}',
      )?.cpuPct,
    ).toBe(100);
  });
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fake ssh link the test drives by hand. */
class FakeLink implements LinkHandle {
  killed = 0;
  private lineListener: (line: string) => void = () => undefined;
  private exitListener: (detail: string) => void = () => undefined;
  onLine(listener: (line: string) => void) {
    this.lineListener = listener;
  }
  onExit(listener: (detail: string) => void) {
    this.exitListener = listener;
  }
  kill() {
    this.killed += 1;
  }
  emit(line: string) {
    this.lineListener(line);
  }
  exit(detail = "") {
    this.exitListener(detail);
  }
}

const harness = (
  overrides: {
    host?: string | null;
    rig?: () => Promise<RigHolder | null>;
    rigDir?: string | null;
  } = {},
) => {
  const links: FakeLink[] = [];
  const hosts: string[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const reader: GamingPcReader = makeGamingPcReader({
    config:
      overrides.host === null
        ? null
        : { host: overrides.host ?? "gamingpc", rigDir: overrides.rigDir ?? null },
    spawnLink: (host) => {
      hosts.push(host);
      const link = new FakeLink();
      links.push(link);
      return link;
    },
    readRigHolder: overrides.rig ?? (async () => null),
    now: () => clock,
    log: (line) => logs.push(line),
    startTimer: () => () => undefined,
  });
  return {
    reader,
    links,
    hosts,
    logs,
    at: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Move the clock and run the 10 s housekeeping once. */
    step: (ms: number) => {
      clock += ms;
      reader.tick(clock);
    },
  };
};

describe("the PC link state machine", () => {
  afterEach(() => undefined);

  it("does nothing and shows nothing when the feature is not configured", () => {
    const h = harness({ host: null });
    expect(h.reader.enabled).toBe(false);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(0);
    expect(h.reader.current(h.at())).toBeNull();
  });

  it("is off: nobody asked, no child", () => {
    const h = harness();
    expect(h.reader.enabled).toBe(true);
    expect(h.links.length).toBe(0);
    expect(h.reader.current(h.at())).toBeNull();
  });

  it("starts: the first touch spawns one child to the configured host", () => {
    const h = harness({ host: "gamingpc" });
    h.reader.touch(h.at());
    expect(h.hosts).toEqual(["gamingpc"]);
    expect(h.reader.current(h.at())).toEqual({ state: "starting" });
  });

  it("spawns once for three touches in two seconds", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.advance(1000);
    h.reader.touch(h.at());
    h.advance(1000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(1);
  });

  it("is on: a line gives the derived numbers", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.advance(2000);
    expect(h.reader.current(h.at())).toEqual({
      state: "on",
      cpuPct: 29,
      gpuPct: 0,
      memUsedGB: 10.5,
      memTotalGB: 15.8,
      memUsedPct: 67,
      ageMs: 2000,
      users: [],
    });
  });

  it("puts a League match first among the users", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(MATCH_LINE);
    const view = h.reader.current(h.at());
    expect(view).toMatchObject({
      state: "on",
      cpuPct: 41,
      gpuPct: 62,
      memUsedGB: 12.8,
      memUsedPct: 81,
      users: [{ kind: "game", game: "league-match", label: "League of Legends" }],
    });
  });

  it("maps the other game kinds", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(
      '{"v":1,"cpuPct":1,"memAvailMb":1000,"memTotalMb":16000,"gpuPct":1,"game":{"kind":"client","process":"LeagueClient"}}',
    );
    expect(h.reader.current(h.at())).toMatchObject({
      users: [{ kind: "game", game: "league-open", label: "LeagueClient" }],
    });
    h.links[0]!.emit(
      '{"v":1,"cpuPct":1,"memAvailMb":1000,"memTotalMb":16000,"gpuPct":1,"game":{"kind":"game","process":"VALORANT-Win64-Shipping"}}',
    );
    expect(h.reader.current(h.at())).toMatchObject({
      users: [{ kind: "game", game: "other", label: "VALORANT" }],
    });
  });

  it("skips a malformed line and keeps the last good reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.links[0]!.emit("not json");
    h.links[0]!.emit('{"v":9}');
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", cpuPct: 29 });
    expect(h.logs.length).toBe(1);
  });

  it("serves a reading no older than 15 s and then nothing (stale, with ageMs)", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.advance(GAMING_PC_STALE_MS);
    h.reader.touch(h.at());
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", ageMs: 15_000 });
    h.advance(1);
    expect(h.reader.current(h.at())).toBeNull();
  });

  it("never reports a negative age when the route clock is a moment behind the reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    expect(h.reader.current(h.at() - 13)).toMatchObject({ state: "on", ageMs: 0 });
  });

  it("stops: 31 s with no touch kills the child once and shows nothing", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.step(10_000);
    h.links[0]!.emit(IDLE_LINE);
    h.step(10_000);
    h.links[0]!.emit(IDLE_LINE);
    expect(h.links[0]!.killed).toBe(0);
    h.step(10_000);
    expect(h.links[0]!.killed).toBe(0);
    h.step(1_000);
    expect(h.links[0]!.killed).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.step(60_000);
    expect(h.links[0]!.killed).toBe(1);
    expect(h.links.length).toBe(1);
  });

  it("asks again after it stopped: a new touch spawns a new child", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.step(31_000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(2);
    expect(h.reader.current(h.at())).toEqual({ state: "starting" });
  });

  it("dead host: an exit with no line shows nothing, then waits 30, 60, 120, 120 s", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.exit("ssh: Could not resolve hostname gamingpc");
    expect(h.reader.current(h.at())).toBeNull();
    expect(h.logs).toEqual([
      "gaming PC stats link down, retrying in 30 s: ssh: Could not resolve hostname gamingpc",
    ]);

    const waits: number[] = [];
    let expectedChildren = 1;
    for (const wait of [30, 60, 120, 120]) {
      h.advance((wait - 1) * 1000);
      h.reader.touch(h.at());
      expect(h.links.length).toBe(expectedChildren);
      h.advance(1000);
      h.reader.touch(h.at());
      expectedChildren += 1;
      expect(h.links.length).toBe(expectedChildren);
      waits.push(wait);
      expect(h.reader.current(h.at())).toEqual({ state: "starting" });
      h.links[expectedChildren - 1]!.exit("ssh: connect timed out");
      expect(h.reader.current(h.at())).toBeNull();
    }
    expect(waits).toEqual([30, 60, 120, 120]);
    expect(h.logs.length).toBe(1);
  });

  it("a connecting child that never answers is killed after 15 s", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.step(10_000);
    h.reader.touch(h.at());
    expect(h.links[0]!.killed).toBe(0);
    h.step(6_000);
    expect(h.links[0]!.killed).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.links[0]!.exit();
    expect(h.links.length).toBe(1);
  });

  it("a 15 s gap between lines kills the child and shows nothing", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    for (let i = 0; i < 3; i += 1) {
      h.advance(5_000);
      h.reader.touch(h.at());
    }
    h.reader.tick(h.at());
    expect(h.links[0]!.killed).toBe(0);
    h.advance(1_000);
    h.reader.touch(h.at());
    h.reader.tick(h.at());
    expect(h.links[0]!.killed).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
  });

  it("respawns at once after the 24-line cap and keeps serving the last reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    for (let i = 0; i < 24; i += 1) {
      h.links[0]!.emit(IDLE_LINE);
      h.advance(5_000);
      h.reader.touch(h.at());
    }
    h.links[0]!.exit();
    expect(h.links.length).toBe(2);
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", cpuPct: 29, ageMs: 5_000 });
    h.links[1]!.emit(MATCH_LINE);
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", cpuPct: 41, ageMs: 0 });
    expect(h.logs).toEqual([]);
  });

  it("does not respawn after the cap when nobody has asked for 31 s", () => {
    const h = harness();
    h.reader.touch(h.at());
    for (let i = 0; i < 7; i += 1) {
      h.links[0]!.emit(IDLE_LINE);
      h.advance(5_000);
    }
    h.links[0]!.exit();
    expect(h.links.length).toBe(1);
    expect(h.logs).toEqual([]);
    expect(h.reader.current(h.at())).toBeNull();
    h.reader.touch(h.at());
    expect(h.links.length).toBe(2);
  });

  it("does not respawn in a tight loop when a child dies right after its first line", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.advance(3_000);
    h.links[0]!.exit("ssh: connection closed");
    expect(h.links.length).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.advance(29_000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(1);
    h.advance(1_000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(2);
  });

  it("a respawned child that dies without a line goes down, not into another respawn", () => {
    const h = harness();
    h.reader.touch(h.at());
    for (let i = 0; i < 24; i += 1) {
      h.links[0]!.emit(IDLE_LINE);
      h.advance(5_000);
      h.reader.touch(h.at());
    }
    h.links[0]!.exit();
    h.links[1]!.exit("ssh: connect timed out");
    expect(h.links.length).toBe(2);
    expect(h.reader.current(h.at())).toBeNull();
  });

  it("ignores events from a child it already replaced or killed", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.step(31_000);
    h.links[0]!.emit(IDLE_LINE);
    h.links[0]!.exit("late");
    expect(h.reader.current(h.at())).toBeNull();
    expect(h.logs).toEqual([]);
  });

  it("stop kills the child and forgets the reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    h.reader.stop();
    expect(h.links[0]!.killed).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.reader.touch(h.at());
    expect(h.links.length).toBe(1);
  });
});

describe("a bot in the reading", () => {
  it("adds the rig holder after the games once the rig directory was read", async () => {
    const holder: RigHolder = {
      bot: "Builder",
      job: "build",
      purpose: "hbots motion throwaway APKs",
    };
    let reads = 0;
    const h = harness({
      rigDir: "/rig",
      rig: async () => {
        reads += 1;
        return holder;
      },
    });
    h.reader.touch(h.at());
    h.links[0]!.emit(MATCH_LINE);
    await flush();
    expect(h.reader.current(h.at())).toMatchObject({
      users: [
        { kind: "game", game: "league-match", label: "League of Legends" },
        { kind: "bot", bot: "Builder", job: "build", purpose: "hbots motion throwaway APKs" },
      ],
    });
    h.reader.current(h.at() + 1);
    expect(reads).toBe(1);
    h.advance(5_001);
    h.links[0]!.emit(IDLE_LINE);
    h.reader.current(h.at());
    expect(reads).toBe(2);
  });

  it("never reads the rig directory when none is configured or the PC is not on", async () => {
    let reads = 0;
    const rig = async () => {
      reads += 1;
      return null;
    };
    const noDir = harness({ rig, rigDir: null });
    noDir.reader.touch(noDir.at());
    noDir.links[0]!.emit(IDLE_LINE);
    noDir.reader.current(noDir.at());
    const off = harness({ rig, rigDir: "/rig" });
    off.reader.touch(off.at());
    off.reader.current(off.at());
    await flush();
    expect(reads).toBe(0);
  });

  it("shows no bot when the rig read fails", async () => {
    const h = harness({
      rigDir: "/rig",
      rig: async () => {
        throw new Error("EACCES");
      },
    });
    h.reader.touch(h.at());
    h.links[0]!.emit(IDLE_LINE);
    await flush();
    expect(h.reader.current(h.at())).toMatchObject({ users: [] });
  });
});

describe("readRigHolder", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
  });

  const rigFixture = async (input: {
    pid?: string | null;
    cmdline?: string | null;
    who?: string | null;
  }) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "gpc-rig-"));
    roots.push(root);
    const rig = NodePath.join(root, "rig");
    const proc = NodePath.join(root, "proc");
    await NodeFSP.mkdir(rig, { recursive: true });
    await NodeFSP.mkdir(proc, { recursive: true });
    if (input.pid != null)
      await NodeFSP.writeFile(NodePath.join(rig, "holder.pid"), `${input.pid}\n`);
    if (input.who != null) await NodeFSP.writeFile(NodePath.join(rig, "who"), input.who);
    if (input.cmdline != null) {
      await NodeFSP.mkdir(NodePath.join(proc, "4242"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(proc, "4242", "cmdline"), input.cmdline);
    }
    return { rig, proc };
  };
  const CMD = "bash\0tools/rig.sh\0_hold\0-Avd\0FindX9Pro-Rig\0";
  const WHO = "1794486437\tBuilder: hbots motion throwaway APKs\tAPK build of 0ce7eae\n";

  it("reads a live rig.sh holder with a good who file", async () => {
    const f = await rigFixture({ pid: "4242", cmdline: CMD, who: WHO });
    expect(await readRigHolder(f.rig, { procRoot: f.proc })).toEqual({
      bot: "Builder",
      job: "build",
      purpose: "hbots motion throwaway APKs",
    });
  });

  it("reads an emulator job", async () => {
    const f = await rigFixture({
      pid: "4242",
      cmdline: CMD,
      who: "1\tBuilder 2: device check\temulator FindX9Pro-Rig\n",
    });
    expect(await readRigHolder(f.rig, { procRoot: f.proc })).toEqual({
      bot: "Builder 2",
      job: "emulator",
      purpose: "device check",
    });
  });

  it("names an unnamed bot 'A bot' and keeps a label with no colon as the bot", async () => {
    const unnamed = await rigFixture({
      pid: "4242",
      cmdline: CMD,
      who: "1\tunnamed bot (thread 9ec43c70)\tsomething else\n",
    });
    expect(await readRigHolder(unnamed.rig, { procRoot: unnamed.proc })).toEqual({
      bot: "A bot",
      job: null,
      purpose: null,
    });
    const plain = await rigFixture({ pid: "4242", cmdline: CMD, who: "1\tVerifier\temulator x\n" });
    expect(await readRigHolder(plain.rig, { procRoot: plain.proc })).toEqual({
      bot: "Verifier",
      job: "emulator",
      purpose: null,
    });
  });

  it("cuts the bot at 24 characters and the purpose at 80", async () => {
    const f = await rigFixture({
      pid: "4242",
      cmdline: CMD,
      who: `1\t${"B".repeat(40)}: ${"p".repeat(120)}\tAPK build of x\n`,
    });
    const holder = await readRigHolder(f.rig, { procRoot: f.proc });
    expect(holder?.bot).toBe("B".repeat(24));
    expect(holder?.purpose).toBe("p".repeat(80));
  });

  it("shows nobody for a dead pid", async () => {
    const f = await rigFixture({ pid: "4242", cmdline: null, who: WHO });
    expect(await readRigHolder(f.rig, { procRoot: f.proc })).toBeNull();
  });

  it("shows nobody when the pid now belongs to another program", async () => {
    const f = await rigFixture({ pid: "4242", cmdline: "node\0server.js\0", who: WHO });
    expect(await readRigHolder(f.rig, { procRoot: f.proc })).toBeNull();
  });

  it("shows nobody for a who file that is garbage or empty", async () => {
    for (const who of ["garbage", "", "\t\t\n", "x\t\tjob\n"]) {
      const f = await rigFixture({ pid: "4242", cmdline: CMD, who });
      expect(await readRigHolder(f.rig, { procRoot: f.proc })).toBeNull();
    }
  });

  it("shows nobody for a holder file that is not a plain pid", async () => {
    for (const pid of ["../4242", "4242 4243", "abc", "", "-1"]) {
      const f = await rigFixture({ pid, cmdline: CMD, who: WHO });
      expect(await readRigHolder(f.rig, { procRoot: f.proc })).toBeNull();
    }
  });

  it("shows nobody when the directory or files are missing", async () => {
    expect(
      await readRigHolder("/nonexistent-rig-dir", { procRoot: "/nonexistent-proc" }),
    ).toBeNull();
    const f = await rigFixture({ pid: null, cmdline: CMD, who: WHO });
    expect(await readRigHolder(f.rig, { procRoot: f.proc })).toBeNull();
  });
});
