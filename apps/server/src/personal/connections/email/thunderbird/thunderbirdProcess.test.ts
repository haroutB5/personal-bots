import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  findThunderbirdPids,
  makeThunderbirdProcess,
  type ThunderbirdProcessConfig,
} from "./thunderbirdProcess.ts";

const proc = (entries: Readonly<Record<string, ReadonlyArray<string>>>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-proc-"));
  for (const [pid, argv] of Object.entries(entries)) {
    NodeFS.mkdirSync(NodePath.join(root, pid));
    NodeFS.writeFileSync(NodePath.join(root, pid, "cmdline"), `${argv.join("\0")}\0`);
  }
  return root;
};

describe("findThunderbirdPids", () => {
  it("finds the hbots profile's main process and ignores content children, look-alikes and other profiles", () => {
    const root = proc({
      "100": ["/home/h/.local/opt/thunderbird/thunderbird-bin", "-P", "hbots-mail"],
      "101": ["/home/h/.local/opt/thunderbird/thunderbird-bin", "-contentproc", "x"],
      "102": ["vim", "thunderbird.txt"],
      "103": ["bash", "-c", "thunderbird -P hbots-mail"],
      "104": ["/usr/bin/thunderbird", "-P", "personal"],
      "105": ["/usr/bin/thunderbird"],
    });
    try {
      expect(findThunderbirdPids(root)).toEqual([100]);
      expect(findThunderbirdPids(root, "personal")).toEqual([104]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds nothing in a folder that does not exist", () => {
    expect(findThunderbirdPids("/nonexistent-proc-root")).toEqual([]);
  });
});

const configIn = (home: string, patch: Partial<ThunderbirdProcessConfig> = {}) => ({
  home,
  binary: NodePath.join(home, "thunderbird"),
  profile: "hbots-mail-test",
  procRoot: "/proc",
  graphicalEnv: () => ({ WAYLAND_DISPLAY: "wayland-test" }),
  exitWaitMs: 5_000,
  ...patch,
});

const withHome = async <A>(run: (home: string) => Promise<A>): Promise<A> => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tb-proc-"));
  try {
    return await run(home);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

const waitFor = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("ThunderbirdProcess", () => {
  it("launches the binary on the hbots profile with the session it found", () =>
    withHome(async (home) => {
      const binary = NodePath.join(home, "thunderbird");
      NodeFS.writeFileSync(
        binary,
        `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$*" "$WAYLAND_DISPLAY" "$HOME" > "${home}/launched"\n`,
        { mode: 0o755 },
      );
      await Effect.runPromise(makeThunderbirdProcess(configIn(home)).launch());
      await waitFor(() => NodeFS.existsSync(NodePath.join(home, "launched")));
      expect(NodeFS.readFileSync(NodePath.join(home, "launched"), "utf8")).toBe(
        `-P hbots-mail-test\nwayland-test\n${home}\n`,
      );
    }));

  it("fails to launch when the binary is missing", () =>
    withHome(async (home) => {
      const failure = await Effect.runPromise(
        Effect.flip(makeThunderbirdProcess(configIn(home)).launch()),
      );
      expect(failure.message).toBe("Thunderbird could not be started.");
    }));

  it("asks the profile's own Thunderbird to quit and waits, leaving other processes alone", () =>
    withHome(async () => {
      const code = "setInterval(() => {}, 1000)";
      const mine = NodeChildProcess.spawn(
        process.execPath,
        ["-e", code, "--", "-P", "hbots-mail-test"],
        { argv0: "thunderbird", stdio: "ignore" },
      );
      const other = NodeChildProcess.spawn(
        process.execPath,
        ["-e", code, "--", "-P", "someone-else"],
        { argv0: "thunderbird", stdio: "ignore" },
      );
      try {
        const service = makeThunderbirdProcess(configIn("/tmp"));
        await waitFor(() => findThunderbirdPids("/proc", "hbots-mail-test").length === 1);
        expect(await Effect.runPromise(service.running())).toBe(true);
        await Effect.runPromise(service.terminate());
        expect(await Effect.runPromise(service.running())).toBe(false);
        expect(findThunderbirdPids("/proc", "someone-else")).toEqual([other.pid]);
      } finally {
        mine.kill("SIGKILL");
        other.kill("SIGKILL");
      }
    }));
});
