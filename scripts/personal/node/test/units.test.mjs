import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const root = NodePath.resolve(import.meta.dirname, "..", "..", "linux");
const systemd = NodePath.join(root, "systemd");

NodeTest.test(
  "every service unit is a template with a valid ExecStart and no Windows paths",
  () => {
    const files = NodeFS.readdirSync(systemd).filter((name) => name.endsWith(".in"));
    NodeAssert.ok(files.length >= 8, `expected the full service set, found ${files.length}`);
    for (const file of files) {
      const text = NodeFS.readFileSync(NodePath.join(systemd, file), "utf8");
      NodeAssert.match(text, /^\[Unit\]/m, `${file}: missing [Unit]`);
      NodeAssert.match(text, /^\[Service\]/m, `${file}: missing [Service]`);
      NodeAssert.match(text, /^ExecStart=/m, `${file}: missing ExecStart`);
      NodeAssert.doesNotMatch(text, /[A-Z]:\\/, `${file}: Windows path`);
      NodeAssert.doesNotMatch(text, /—/, `${file}: em dash`);
    }
  },
);

NodeTest.test("every timer has an OnCalendar and is persistent", () => {
  const timers = NodeFS.readdirSync(systemd).filter((name) => name.endsWith(".timer"));
  NodeAssert.ok(timers.length >= 4);
  for (const file of timers) {
    const text = NodeFS.readFileSync(NodePath.join(systemd, file), "utf8");
    NodeAssert.match(text, /^\[Timer\]/m, `${file}: missing [Timer]`);
    NodeAssert.match(text, /^OnCalendar=/m, `${file}: missing OnCalendar`);
    NodeAssert.match(text, /^Persistent=true/m, `${file}: not persistent`);
    NodeAssert.match(text, /^WantedBy=timers\.target/m, `${file}: not installable`);
  }
});

NodeTest.test("install script renders absolute paths and supports dry-run", () => {
  const script = NodeFS.readFileSync(NodePath.join(root, "install-units.sh"), "utf8");
  NodeAssert.match(script, /--dry-run/);
  NodeAssert.match(script, /systemctl --user daemon-reload/);
  NodeAssert.match(script, /@REPO@/);
  NodeAssert.match(script, /@NODE@/);
  NodeAssert.match(script, /ConditionPathExists|enable/);
});

NodeTest.test("a reinstall never enables the unproven nightly timers", () => {
  const script = NodeFS.readFileSync(NodePath.join(root, "install-units.sh"), "utf8");
  const core = script.slice(script.indexOf("CORE_UNITS=("), script.indexOf("OPTIONAL_UNITS="));
  NodeAssert.doesNotMatch(core, /hbots-nightly-updates\.timer/);
  NodeAssert.doesNotMatch(core, /hbots-upstream-sync\.timer/);
  NodeAssert.match(
    script,
    /MANUAL_UNITS=\(hbots-upstream-sync\.timer hbots-nightly-updates\.timer\)/,
  );
});

NodeTest.test("hbots service is distinct from the optional tunnel unit", () => {
  const hbots = NodeFS.readFileSync(NodePath.join(systemd, "hbots.service.in"), "utf8");
  NodeAssert.match(hbots, /hbots\.mjs serve --root dev/);
  NodeAssert.match(hbots, /Restart=on-failure/);
  const cloudflared = NodeFS.readFileSync(NodePath.join(systemd, "cloudflared.service.in"), "utf8");
  NodeAssert.match(cloudflared, /ConditionPathExists/);
});

const installInTempHome = (args) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-units-"));
  const bin = NodePath.join(home, "bin");
  NodeFS.mkdirSync(bin);
  const calls = NodePath.join(home, "systemctl.calls");
  NodeFS.writeFileSync(NodePath.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${calls}"\n`, {
    mode: 0o755,
  });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  const result = NodeChildProcess.spawnSync(
    "bash",
    [
      NodePath.join(root, "install-units.sh"),
      "--node",
      process.execPath,
      "--python",
      "/usr/bin/python3",
      ...args,
    ],
    { env, encoding: "utf8" },
  );
  const read = (file) => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null);
  return { home, result, calls: read(calls), read };
};

NodeTest.test("install places the no-swap drop-in for hbots.service", () => {
  const { home, result, calls, read } = installInTempHome(["--no-enable"]);
  try {
    NodeAssert.equal(result.status, 0, result.stderr);
    const dropIn = NodePath.join(home, ".config/systemd/user/hbots.service.d/50-no-swap.conf");
    NodeAssert.equal(
      read(dropIn),
      "# The server must not be swapped out by heavy jobs. Measured 14 Nov 2026:\n" +
        "# 769,575 pages out and 682,169 back in 2.7 h, 224 stall-seconds a day.\n" +
        "[Service]\n" +
        "MemorySwapMax=0\n",
    );
    NodeAssert.match(result.stdout, new RegExp(`wrote ${dropIn}`));
    NodeAssert.equal(
      read(NodePath.join(home, ".config/systemd/user/hbots.service.d/20-runtime-NodePath.conf")),
      null,
    );
    NodeAssert.equal(calls, "--user daemon-reload\n");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

NodeTest.test("a dry run names the drop-in and writes nothing", () => {
  const { home, result, calls } = installInTempHome(["--dry-run"]);
  try {
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.match(result.stdout, /would write .*\/hbots\.service\.d\/50-no-swap\.conf/);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(home, ".config")), false);
    NodeAssert.equal(calls, null);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
