import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeThunderbirdProcess,
  runningThunderbirdPid,
  type ThunderbirdProcessConfig,
} from "./thunderbirdProcess.ts";

const PROFILE = "hbots-mail-test";

const makeHome = (): { readonly home: string; readonly profileDir: string } => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tb-proc-"));
  const profileDir = NodePath.join(home, ".thunderbird", "p.test");
  NodeFS.mkdirSync(profileDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, ".thunderbird", "profiles.ini"),
    `[Profile0]\nName=${PROFILE}\nIsRelative=1\nPath=p.test\n`,
  );
  return { home, profileDir };
};

const lockTo = (profileDir: string, pid: number) =>
  NodeFS.symlinkSync(`127.0.1.1:+${pid}`, NodePath.join(profileDir, "lock"));

const fakeProc = (
  entries: Readonly<Record<string, { exe: string; argv: ReadonlyArray<string> }>>,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-proc-"));
  for (const [pid, entry] of Object.entries(entries)) {
    NodeFS.mkdirSync(NodePath.join(root, pid));
    NodeFS.symlinkSync(entry.exe, NodePath.join(root, pid, "exe"));
    NodeFS.writeFileSync(NodePath.join(root, pid, "cmdline"), `${entry.argv.join("\0")}\0`);
  }
  return root;
};

const withHome = async <A>(run: (home: string, profileDir: string) => Promise<A>): Promise<A> => {
  const { home, profileDir } = makeHome();
  try {
    return await run(home, profileDir);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

describe("runningThunderbirdPid", () => {
  it("finds the profile's Thunderbird through its lock however it was started", () =>
    withHome(async (home, profileDir) => {
      lockTo(profileDir, 100);
      const procRoot = fakeProc({
        "100": { exe: "/opt/thunderbird/thunderbird-bin", argv: ["/opt/thunderbird/thunderbird"] },
      });
      try {
        expect(runningThunderbirdPid({ home, profile: PROFILE, procRoot })).toBe(100);
      } finally {
        NodeFS.rmSync(procRoot, { recursive: true, force: true });
      }
    }));

  it("finds nothing for a stale lock, a reused PID, another profile, another home or no lock", () =>
    withHome(async (home, profileDir) => {
      const procRoot = fakeProc({
        "200": { exe: "/usr/bin/bash", argv: ["bash", "-c", "thunderbird -P hbots-mail-test"] },
        "300": {
          exe: "/opt/thunderbird/thunderbird-bin",
          argv: ["/opt/thunderbird/thunderbird", "-P", "personal"],
        },
      });
      try {
        const where = { home, profile: PROFILE, procRoot };
        expect(runningThunderbirdPid(where)).toBeNull();
        lockTo(profileDir, 999);
        expect(runningThunderbirdPid(where)).toBeNull();
        NodeFS.rmSync(NodePath.join(profileDir, "lock"));
        lockTo(profileDir, 200);
        expect(runningThunderbirdPid(where)).toBeNull();
        NodeFS.rmSync(NodePath.join(profileDir, "lock"));
        lockTo(profileDir, 300);
        expect(runningThunderbirdPid(where)).toBeNull();
        expect(runningThunderbirdPid({ ...where, home: "/nonexistent-home" })).toBeNull();
        expect(runningThunderbirdPid({ ...where, profile: "missing" })).toBeNull();
      } finally {
        NodeFS.rmSync(procRoot, { recursive: true, force: true });
      }
    }));
});

const configIn = (home: string, patch: Partial<ThunderbirdProcessConfig> = {}) => ({
  home,
  binary: NodePath.join(home, "thunderbird"),
  profile: PROFILE,
  procRoot: "/proc",
  graphicalEnv: () => ({ WAYLAND_DISPLAY: "wayland-test" }),
  exitWaitMs: 1_500,
  startWaitMs: 5_000,
  ...patch,
});

const waitFor = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A process that runs as `thunderbird-bin`, takes the profile lock the way Thunderbird does, and stays up. */
const FAKE_THUNDERBIRD = (lockPath: string, ignoreTerm: boolean) => `
const fs = require("node:fs");
fs.symlinkSync("127.0.1.1:+" + process.pid, ${JSON.stringify(lockPath)});
${ignoreTerm ? 'process.on("SIGTERM", () => {});' : 'process.on("SIGTERM", () => { fs.rmSync(' + JSON.stringify(lockPath) + ", { force: true }); process.exit(0); });"}
setInterval(() => {}, 1000);
`;

const installFake = (home: string, name: string): string => {
  const path = NodePath.join(home, name);
  NodeFS.copyFileSync(process.execPath, path);
  NodeFS.chmodSync(path, 0o755);
  return path;
};

describe("ThunderbirdProcess", () => {
  it("launches the binary on the hbots profile with the session it found and waits for the lock", () =>
    withHome(async (home, profileDir) => {
      const fake = installFake(home, "thunderbird-bin");
      const lockPath = NodePath.join(profileDir, "lock");
      NodeFS.writeFileSync(NodePath.join(home, "fake.cjs"), FAKE_THUNDERBIRD(lockPath, false));
      const binary = NodePath.join(home, "thunderbird");
      NodeFS.writeFileSync(
        binary,
        `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$*" "$WAYLAND_DISPLAY" "$HOME" > "${home}/launched"\nexec "${fake}" "${home}/fake.cjs"\n`,
        { mode: 0o755 },
      );
      const service = makeThunderbirdProcess(configIn(home));
      try {
        await Effect.runPromise(service.launch());
        expect(NodeFS.readFileSync(NodePath.join(home, "launched"), "utf8")).toBe(
          `-P ${PROFILE}\nwayland-test\n${home}\n`,
        );
        expect(await Effect.runPromise(service.running())).toBe(true);
      } finally {
        const pid = runningThunderbirdPid(configIn(home));
        if (pid !== null) process.kill(pid, "SIGKILL");
      }
    }));

  it("fails to launch when the binary is missing", () =>
    withHome(async (home) => {
      const failure = await Effect.runPromise(
        Effect.flip(makeThunderbirdProcess(configIn(home)).launch()),
      );
      expect(failure.message).toBe("Thunderbird could not be started.");
    }));

  it("fails to launch when no Thunderbird takes the profile", () =>
    withHome(async (home) => {
      NodeFS.writeFileSync(NodePath.join(home, "thunderbird"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const failure = await Effect.runPromise(
        Effect.flip(makeThunderbirdProcess(configIn(home, { startWaitMs: 400 })).launch()),
      );
      expect(failure.message).toBe("Thunderbird could not be started.");
    }));

  it("quits the profile's Thunderbird and waits for it, leaving another home's process alone", () =>
    withHome(async (home, profileDir) => {
      const other = makeHome();
      const fake = installFake(home, "thunderbird-bin");
      const otherFake = installFake(other.home, "thunderbird-bin");
      const mine = NodeChildProcess.spawn(
        fake,
        ["-e", FAKE_THUNDERBIRD(NodePath.join(profileDir, "lock"), false)],
        { stdio: "ignore" },
      );
      const theirs = NodeChildProcess.spawn(
        otherFake,
        ["-e", FAKE_THUNDERBIRD(NodePath.join(other.profileDir, "lock"), false)],
        { stdio: "ignore" },
      );
      try {
        const service = makeThunderbirdProcess(configIn(home));
        await waitFor(
          () =>
            runningThunderbirdPid(configIn(home)) !== null &&
            runningThunderbirdPid(configIn(other.home)) !== null,
        );
        expect(await Effect.runPromise(service.running())).toBe(true);
        await Effect.runPromise(service.terminate());
        expect(await Effect.runPromise(service.running())).toBe(false);
        expect(runningThunderbirdPid(configIn(other.home))).toBe(theirs.pid);
      } finally {
        mine.kill("SIGKILL");
        theirs.kill("SIGKILL");
        NodeFS.rmSync(other.home, { recursive: true, force: true });
      }
    }));

  it("fails instead of reporting success while Thunderbird keeps running", () =>
    withHome(async (home, profileDir) => {
      const fake = installFake(home, "thunderbird-bin");
      const stubborn = NodeChildProcess.spawn(
        fake,
        ["-e", FAKE_THUNDERBIRD(NodePath.join(profileDir, "lock"), true)],
        { stdio: "ignore" },
      );
      try {
        const service = makeThunderbirdProcess(configIn(home, { exitWaitMs: 600 }));
        await waitFor(() => runningThunderbirdPid(configIn(home)) !== null);
        const failure = await Effect.runPromise(Effect.flip(service.terminate()));
        expect(failure.message).toBe("Thunderbird did not close in time.");
        expect(await Effect.runPromise(service.running())).toBe(true);
      } finally {
        stubborn.kill("SIGKILL");
      }
    }));
});
