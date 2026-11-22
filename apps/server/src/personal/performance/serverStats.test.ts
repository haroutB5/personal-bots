// @effect-diagnostics nodeBuiltinImport:off - the real-child tests need a fake ssh on disk and a real sh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  SERVER_REMOTE_COMMAND,
  SERVER_SSH_ARGS,
  SERVER_STATS_STALE_MS,
  cpuPctBetween,
  makeServerStatsReader,
  parseServerLine,
  parseServerStatsConfig,
  serverLinkCommand,
  spawnServerLink,
  type LinkHandle,
  type ServerStatsReader,
} from "./serverStats.ts";
import { SERVER_STATS_SCRIPT } from "./serverStatsScript.ts";

const MEM = "16036124 10341828";
const DISK = "509943480320 255529635840";
/** One reading line: user and idle jiffies vary, the rest is fixed. */
const hbs = (user: number, idle: number, mem = MEM, disk = DISK) =>
  `hbs1 ${user} 0 0 ${idle} 0 0 0 0 ${mem} ${disk}`;

/** Lines whose CPU between neighbours is 12% (120 busy of every 1000 jiffies). */
const ticker = () => {
  let n = 0;
  return () => {
    n += 1;
    return hbs(1000 + n * 120, 9000 + n * 880);
  };
};

describe("parseServerStatsConfig", () => {
  it("is off with no warning when the host is unset or empty", () => {
    expect(parseServerStatsConfig({})).toEqual({ config: null, warning: null });
    expect(parseServerStatsConfig({ T3CODE_PERSONAL_SERVER_STATS_HOST: "  " })).toEqual({
      config: null,
      warning: null,
    });
  });

  it("never reads the old gaming PC variables", () => {
    expect(
      parseServerStatsConfig({
        T3CODE_PERSONAL_GAMINGPC_HOST: "gamingpc",
        T3CODE_PERSONAL_GAMINGPC_RIG_DIR: "/home/harout/.cache/hbots-rig",
      }),
    ).toEqual({ config: null, warning: null });
  });

  it("accepts a plain ssh alias", () => {
    expect(
      parseServerStatsConfig({ T3CODE_PERSONAL_SERVER_STATS_HOST: "omarchy-old" }).config,
    ).toEqual({ host: "omarchy-old" });
    expect(
      parseServerStatsConfig({ T3CODE_PERSONAL_SERVER_STATS_HOST: "srv-1.lan" }).config,
    ).toEqual({ host: "srv-1.lan" });
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
    "omarchy-old\n-v",
  ])("rejects %j as not a plain ssh host alias", (host) => {
    expect(parseServerStatsConfig({ T3CODE_PERSONAL_SERVER_STATS_HOST: host })).toEqual({
      config: null,
      warning: "server stats off: T3CODE_PERSONAL_SERVER_STATS_HOST is not a plain ssh host alias",
    });
  });
});

describe("the fixed ssh command", () => {
  it("never reads a request, client or environment value", () => {
    expect(SERVER_SSH_ARGS).toEqual([
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
    expect(SERVER_REMOTE_COMMAND).toBe("exec timeout 170 sh -s");
    const command = serverLinkCommand("omarchy-old");
    const ssh = ["ssh", ...SERVER_SSH_ARGS, "omarchy-old", SERVER_REMOTE_COMMAND];
    if (process.platform === "linux") {
      expect(command).toEqual({ file: "setpriv", args: ["--pdeathsig", "KILL", ...ssh] });
    } else {
      expect(command).toEqual({ file: "ssh", args: ssh.slice(1) });
    }
  });

  it("sends a script that only reads on the server and ends by itself", () => {
    expect(SERVER_STATS_SCRIPT).toContain("max=25");
    expect(SERVER_STATS_SCRIPT).toContain('[ "$n" -ge "$max" ] && exit 0');
    expect(SERVER_STATS_SCRIPT).toContain("|| exit 0");
    for (const writer of [
      "rm ",
      "mv ",
      "cp ",
      "kill",
      "tee",
      "dd ",
      "curl",
      "wget",
      "sudo",
      "docker",
      "systemctl",
      "chmod",
      "mkdir",
      "touch",
      "eval",
    ]) {
      expect(SERVER_STATS_SCRIPT).not.toContain(writer);
    }
    // The only redirections: read /proc/stat, drop df's errors.
    const redirections = SERVER_STATS_SCRIPT.match(/\d?[<>]+\s*\S+/g) ?? [];
    expect(redirections.toSorted()).toEqual(["2>/dev/null", "< /proc/stat"]);
    const files = SERVER_STATS_SCRIPT.match(/\/(proc|sys|etc|home|var|tmp)\/[\w/]*/g) ?? [];
    expect([...new Set(files)].toSorted()).toEqual(["/proc/meminfo", "/proc/stat"]);
  });
});

describe("parseServerLine (the Linux reading)", () => {
  it("parses a real line from omarchy-old", () => {
    expect(
      parseServerLine(
        "hbs1 1990765 237018 1032661 285929975 482906 466595 256254 0 16036124 10341828 509943480320 255529635840",
      ),
    ).toEqual({
      cpuTotal: 1990765 + 237018 + 1032661 + 285929975 + 482906 + 466595 + 256254 + 0,
      cpuIdle: 285929975 + 482906,
      memTotalKb: 16036124,
      memAvailKb: 10341828,
      diskTotalBytes: 509943480320,
      diskAvailBytes: 255529635840,
    });
  });

  it("keeps a missing disk as null", () => {
    expect(parseServerLine(hbs(1, 2, MEM, "- -"))).toMatchObject({
      diskTotalBytes: null,
      diskAvailBytes: null,
    });
  });

  it.each([
    ["empty", ""],
    ["not a reading", "Welcome to omarchy"],
    ["the wrong tag", hbs(1, 2).replace("hbs1", "hbs2")],
    ["a missing field", hbs(1, 2).split(" ").slice(0, 12).join(" ")],
    ["an extra field", `${hbs(1, 2)} 7`],
    ["a negative counter", hbs(1, 2).replace(" 1 ", " -1 ")],
    ["a decimal", hbs(1, 2, "16036124.5 10341828")],
    ["zero memory", hbs(1, 2, "0 0")],
    ["a half disk", hbs(1, 2, MEM, "- 5")],
    ["a zero-size disk", hbs(1, 2, MEM, "0 0")],
    ["a counter past 2^53", hbs(1, 2).replace(" 1 ", " 99999999999999999 ")],
    ["shell output", "hbs1 $(id) 0 0 0 0 0 0 0 1 1 1 1"],
  ])("refuses %s", (_name, line) => {
    expect(parseServerLine(line)).toBeNull();
  });

  it("caps available memory and disk at their totals", () => {
    const sample = parseServerLine(hbs(1, 2, "100 900", "1000 5000"));
    expect(sample?.memAvailKb).toBe(100);
    expect(sample?.diskAvailBytes).toBe(1000);
  });
});

describe("cpuPctBetween", () => {
  const at = (user: number, idle: number) => parseServerLine(hbs(user, idle))!;

  it("is the busy share of the jiffies between two readings", () => {
    expect(cpuPctBetween(at(1000, 9000), at(1120, 9880))).toBeCloseTo(12, 5);
    expect(cpuPctBetween(at(1000, 9000), at(2000, 9000))).toBe(100);
    expect(cpuPctBetween(at(1000, 9000), at(1000, 10000))).toBe(0);
  });

  it("counts iowait as idle", () => {
    const prev = parseServerLine("hbs1 100 0 0 800 100 0 0 0 1 1 - -")!;
    const next = parseServerLine("hbs1 200 0 0 1600 200 0 0 0 1 1 - -")!;
    expect(cpuPctBetween(prev, next)).toBe(10);
  });

  it("is null when the counters did not move or went back (a reboot)", () => {
    expect(cpuPctBetween(at(1000, 9000), at(1000, 9000))).toBeNull();
    expect(cpuPctBetween(at(1000, 9000), at(10, 90))).toBeNull();
  });
});

/** A fake ssh link the test drives by hand. */
class FakeLink implements LinkHandle {
  killed = 0;
  private lineListener: (line: string) => void = () => undefined;
  private exitListener: (detail: string, forceFail: boolean) => void = () => undefined;
  onLine(listener: (line: string) => void) {
    this.lineListener = listener;
  }
  onExit(listener: (detail: string, forceFail: boolean) => void) {
    this.exitListener = listener;
  }
  kill() {
    this.killed += 1;
  }
  emit(line: string) {
    this.lineListener(line);
  }
  exit(detail = "", forceFail = false) {
    this.exitListener(detail, forceFail);
  }
}

const harness = (overrides: { host?: string | null } = {}) => {
  const links: FakeLink[] = [];
  const hosts: string[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const next = ticker();
  const reader: ServerStatsReader = makeServerStatsReader({
    config: overrides.host === null ? null : { host: overrides.host ?? "omarchy-old" },
    spawnLink: (host) => {
      hosts.push(host);
      const link = new FakeLink();
      links.push(link);
      return link;
    },
    now: () => clock,
    log: (line) => logs.push(line),
    startTimer: () => () => undefined,
  });
  return {
    reader,
    links,
    hosts,
    logs,
    /** The next 12% line. */
    line: next,
    /** A child's first two lines: the first reading. */
    open: (link: FakeLink) => {
      link.emit(next());
      link.emit(next());
    },
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

const ON_12 = {
  state: "on",
  cpuPct: 12,
  memUsedGB: 5.4,
  memTotalGB: 15.3,
  memUsedPct: 36,
  diskFreeGB: 238,
  diskTotalGB: 474.9,
} as const;

describe("the server link state machine", () => {
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
    const h = harness({ host: "omarchy-old" });
    h.reader.touch(h.at());
    expect(h.hosts).toEqual(["omarchy-old"]);
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

  it("stays starting after one line: CPU needs two", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.emit(h.line());
    expect(h.reader.current(h.at())).toEqual({ state: "starting" });
  });

  it("is on after two lines, with CPU, RAM and disk worked out", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.advance(2000);
    expect(h.reader.current(h.at())).toEqual({ ...ON_12, ageMs: 2000 });
  });

  it("follows later lines and keeps the last CPU when the counters stall", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.links[0]!.emit(hbs(1000 + 2 * 120 + 500, 9000 + 2 * 880 + 500));
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", cpuPct: 50 });
    h.links[0]!.emit(hbs(1000 + 2 * 120 + 500, 9000 + 2 * 880 + 500, "16036124 1036124"));
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", cpuPct: 50, memUsedPct: 94 });
  });

  it("skips a malformed line once in the log and keeps the last good reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.links[0]!.emit("not a reading");
    h.links[0]!.emit("hbs1 x");
    expect(h.reader.current(h.at())).toMatchObject(ON_12);
    expect(h.logs).toEqual(["server stats: skipped a line that is not a reading"]);
  });

  it("serves a reading no older than 15 s and then nothing", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.advance(SERVER_STATS_STALE_MS);
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", ageMs: SERVER_STATS_STALE_MS });
    h.advance(1);
    expect(h.reader.current(h.at())).toBeNull();
  });

  it("never reports a negative age when the route clock is a moment behind the reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    expect(h.reader.current(h.at() - 50)).toMatchObject({ state: "on", ageMs: 0 });
  });

  it("stops: 31 s with no touch kills the child once and shows nothing", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.step(10_000);
    h.links[0]!.emit(h.line());
    h.step(10_000);
    h.links[0]!.emit(h.line());
    h.step(11_000);
    expect(h.links[0]!.killed).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.step(10_000);
    expect(h.links[0]!.killed).toBe(1);
    expect(h.links.length).toBe(1);
  });

  it("asks again after it stopped: a new touch spawns a new child", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.step(31_000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(2);
    expect(h.reader.current(h.at())).toEqual({ state: "starting" });
  });

  it("dead host: an exit with no line shows nothing, then waits 30, 60, 120, 120 s", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.links[0]!.exit("ssh: Could not resolve hostname omarchy-old");
    expect(h.reader.current(h.at())).toBeNull();
    expect(h.logs).toEqual([
      "server stats link down, retrying in 30 s: ssh: Could not resolve hostname omarchy-old",
    ]);
    let expectedChildren = 1;
    for (const wait of [30, 60, 120, 120]) {
      h.advance((wait - 1) * 1000);
      h.reader.touch(h.at());
      expect(h.links.length).toBe(expectedChildren);
      h.advance(1000);
      h.reader.touch(h.at());
      expectedChildren += 1;
      expect(h.links.length).toBe(expectedChildren);
      expect(h.reader.current(h.at())).toEqual({ state: "starting" });
      h.links[expectedChildren - 1]!.exit("ssh: connect timed out");
      expect(h.reader.current(h.at())).toBeNull();
    }
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
    h.open(h.links[0]!);
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

  it("respawns at once after the 25-line cap and keeps serving the last reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    for (let i = 0; i < 25; i += 1) {
      h.links[0]!.emit(h.line());
      h.advance(5_000);
      h.reader.touch(h.at());
    }
    h.links[0]!.exit();
    expect(h.links.length).toBe(2);
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", cpuPct: 12, ageMs: 5_000 });
    h.links[1]!.emit(h.line());
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", ageMs: 5_000 });
    h.links[1]!.emit(hbs(900_000, 900_000));
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", ageMs: 0 });
    expect(h.logs).toEqual([]);
  });

  it("does not respawn after the cap when nobody has asked for 31 s", () => {
    const h = harness();
    h.reader.touch(h.at());
    for (let i = 0; i < 8; i += 1) {
      h.links[0]!.emit(h.line());
      h.advance(5_000);
    }
    h.links[0]!.exit();
    expect(h.links.length).toBe(1);
    expect(h.logs).toEqual([]);
    expect(h.reader.current(h.at())).toBeNull();
    h.reader.touch(h.at());
    expect(h.links.length).toBe(2);
  });

  it("does not respawn in a tight loop when a child dies right after its first reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
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

  it("an over-long line counts as a failed run even after a healthy one", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.advance(25_000);
    h.reader.touch(h.at());
    h.links[0]!.emit(h.line());
    h.links[0]!.exit("stdout line over 64 KB", true);
    expect(h.links.length).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.advance(29_000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(1);
    h.advance(1_000);
    h.reader.touch(h.at());
    expect(h.links.length).toBe(2);
  });

  it("ignores events from a child it already killed", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.step(31_000);
    h.open(h.links[0]!);
    h.links[0]!.exit("late");
    expect(h.reader.current(h.at())).toBeNull();
    expect(h.logs).toEqual([]);
  });

  it("stop kills the child and forgets the reading", () => {
    const h = harness();
    h.reader.touch(h.at());
    h.open(h.links[0]!);
    h.reader.stop();
    expect(h.links[0]!.killed).toBe(1);
    expect(h.reader.current(h.at())).toBeNull();
    h.reader.touch(h.at());
    expect(h.links.length).toBe(1);
  });
});

const SERVER_STATS_MODULE = new URL("./serverStats.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "linux")("the real script on this Linux machine", () => {
  it("prints readings this parser accepts, from the real /proc and df", async () => {
    const child = NodeChildProcess.spawn("sh", ["-s"], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.end(SERVER_STATS_SCRIPT);
    child.stdout.setEncoding("utf8");
    const lines = await new Promise<string[]>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("no two lines in 10 s")), 10_000);
      child.stdout.on("data", (chunk: string) => {
        text += chunk;
        const got = text.split("\n").filter((line) => line !== "");
        if (got.length >= 2) {
          clearTimeout(timer);
          resolve(got.slice(0, 2));
        }
      });
    });
    child.kill("SIGKILL");
    const [first, second] = lines.map(parseServerLine);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.memTotalKb).toBeGreaterThan(0);
    expect(first!.diskTotalBytes).toBeGreaterThan(0);
    const cpu = cpuPctBetween(first!, second!);
    expect(cpu === null || (cpu >= 0 && cpu <= 100)).toBe(true);
  });
});

describe("the real ssh child", () => {
  const roots: string[] = [];
  const pids: number[] = [];
  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A fake `ssh` on PATH: records its pid and argv, then behaves like `body`. */
  const fakeSsh = async (body: string) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "srv-ssh-"));
    roots.push(root);
    const bin = NodePath.join(root, "bin");
    await NodeFSP.mkdir(bin);
    const pidFile = NodePath.join(root, "ssh.pid");
    const argvFile = NodePath.join(root, "ssh.argv");
    await NodeFSP.writeFile(
      NodePath.join(bin, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\necho $$ > '${pidFile}'\n${body}\n`,
      { mode: 0o755 },
    );
    return { root, bin, pidFile, argvFile };
  };

  const waitForPid = async (file: string) => {
    for (let i = 0; i < 100; i += 1) {
      try {
        const pid = Number((await NodeFSP.readFile(file, "utf8")).trim());
        if (pid > 0) return pid;
      } catch {
        // Not written yet.
      }
      await sleep(50);
    }
    throw new Error("the fake ssh never started");
  };

  it("sends the fixed argv and the script, and reads its lines", async () => {
    const fake = await fakeSsh(`cat > /dev/null; echo '${hbs(1, 2)}'; echo '${hbs(3, 4)}'`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.bin}:${oldPath ?? ""}`;
    try {
      const lines: string[] = [];
      const link = spawnServerLink("omarchy-old");
      link.onLine((line) => lines.push(line));
      await new Promise<void>((resolve) => link.onExit(() => resolve()));
      expect(lines).toEqual([hbs(1, 2), hbs(3, 4)]);
      const argv = (await NodeFSP.readFile(fake.argvFile, "utf8")).trimEnd().split("\n");
      expect(argv).toEqual([...SERVER_SSH_ARGS, "omarchy-old", SERVER_REMOTE_COMMAND]);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it.each([
    ["before the first line", "exec sleep 600"],
    ["in the middle of a stream", `while :; do echo '${hbs(1, 2)}'; sleep 1; done`],
  ])("does not outlive a server that was killed with SIGKILL, %s", async (_name, body) => {
    const fake = await fakeSsh(body);
    const driver = NodePath.join(fake.root, "driver.mjs");
    await NodeFSP.writeFile(
      driver,
      `import { spawnServerLink } from ${JSON.stringify(SERVER_STATS_MODULE)};\nspawnServerLink("fakesrv");\nsetInterval(() => undefined, 1000);\n`,
    );
    const server = NodeChildProcess.spawn(process.execPath, [driver], {
      env: { ...process.env, PATH: `${fake.bin}:${process.env.PATH ?? ""}` },
      stdio: "ignore",
    });
    const sshPid = await waitForPid(fake.pidFile);
    pids.push(sshPid);
    pids.push(server.pid!);
    expect(alive(sshPid)).toBe(true);
    server.kill("SIGKILL");
    const killedAt = Date.now();
    while (alive(sshPid) && Date.now() - killedAt < 15_000) await sleep(100);
    expect(alive(sshPid)).toBe(false);
  });

  it("drops the link when the server sends 64 KB with no newline", async () => {
    const fake = await fakeSsh(`head -c 20000000 /dev/zero | tr '\\0' A`);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.bin}:${oldPath ?? ""}`;
    try {
      const lines: string[] = [];
      const link = spawnServerLink("fakesrv");
      link.onLine((line) => lines.push(line));
      const exit = await new Promise<{ detail: string; forceFail: boolean | undefined }>(
        (resolve) => link.onExit((detail, forceFail) => resolve({ detail, forceFail })),
      );
      expect(lines).toEqual([]);
      expect(exit.detail).toContain("line over 64 KB");
      expect(exit.forceFail).toBe(true);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
