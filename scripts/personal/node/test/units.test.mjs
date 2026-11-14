import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..", "linux");
const systemd = path.join(root, "systemd");

test("every service unit is a template with a valid ExecStart and no Windows paths", () => {
  const files = fs.readdirSync(systemd).filter((name) => name.endsWith(".in"));
  assert.ok(files.length >= 8, `expected the full service set, found ${files.length}`);
  for (const file of files) {
    const text = fs.readFileSync(path.join(systemd, file), "utf8");
    assert.match(text, /^\[Unit\]/m, `${file}: missing [Unit]`);
    assert.match(text, /^\[Service\]/m, `${file}: missing [Service]`);
    assert.match(text, /^ExecStart=/m, `${file}: missing ExecStart`);
    assert.doesNotMatch(text, /[A-Z]:\\/, `${file}: Windows path`);
    assert.doesNotMatch(text, /—/, `${file}: em dash`);
  }
});

test("every timer has an OnCalendar and is persistent", () => {
  const timers = fs.readdirSync(systemd).filter((name) => name.endsWith(".timer"));
  assert.ok(timers.length >= 4);
  for (const file of timers) {
    const text = fs.readFileSync(path.join(systemd, file), "utf8");
    assert.match(text, /^\[Timer\]/m, `${file}: missing [Timer]`);
    assert.match(text, /^OnCalendar=/m, `${file}: missing OnCalendar`);
    assert.match(text, /^Persistent=true/m, `${file}: not persistent`);
    assert.match(text, /^WantedBy=timers\.target/m, `${file}: not installable`);
  }
});

test("install script renders absolute paths and supports dry-run", () => {
  const script = fs.readFileSync(path.join(root, "install-units.sh"), "utf8");
  assert.match(script, /--dry-run/);
  assert.match(script, /systemctl --user daemon-reload/);
  assert.match(script, /@REPO@/);
  assert.match(script, /@NODE@/);
  assert.match(script, /ConditionPathExists|enable/);
});

test("a reinstall never enables the unproven nightly timers", () => {
  const script = fs.readFileSync(path.join(root, "install-units.sh"), "utf8");
  const core = script.slice(script.indexOf("CORE_UNITS=("), script.indexOf("OPTIONAL_UNITS="));
  assert.doesNotMatch(core, /hbots-nightly-updates\.timer/);
  assert.doesNotMatch(core, /hbots-upstream-sync\.timer/);
  assert.match(script, /MANUAL_UNITS=\(hbots-upstream-sync\.timer hbots-nightly-updates\.timer\)/);
});

test("hbots service is distinct from the optional tunnel unit", () => {
  const hbots = fs.readFileSync(path.join(systemd, "hbots.service.in"), "utf8");
  assert.match(hbots, /hbots\.mjs serve --root dev/);
  assert.match(hbots, /Restart=on-failure/);
  const cloudflared = fs.readFileSync(path.join(systemd, "cloudflared.service.in"), "utf8");
  assert.match(cloudflared, /ConditionPathExists/);
});

const installInTempHome = (args) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-units-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(home, "systemctl.calls");
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  const result = spawnSync(
    "bash",
    [path.join(root, "install-units.sh"), "--node", process.execPath, "--python", "/usr/bin/python3", ...args],
    { env, encoding: "utf8" },
  );
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  return { home, result, calls: read(calls), read };
};

test("install places the no-swap drop-in for hbots.service", () => {
  const { home, result, calls, read } = installInTempHome(["--no-enable"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    const dropIn = path.join(home, ".config/systemd/user/hbots.service.d/50-no-swap.conf");
    assert.equal(
      read(dropIn),
      "# The server must not be swapped out by heavy jobs. Measured 14 Nov 2026:\n" +
        "# 769,575 pages out and 682,169 back in 2.7 h, 224 stall-seconds a day.\n" +
        "[Service]\n" +
        "MemorySwapMax=0\n",
    );
    assert.match(result.stdout, new RegExp(`wrote ${dropIn}`));
    assert.equal(read(path.join(home, ".config/systemd/user/hbots.service.d/20-runtime-path.conf")), null);
    assert.equal(calls, "--user daemon-reload\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a dry run names the drop-in and writes nothing", () => {
  const { home, result, calls } = installInTempHome(["--dry-run"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would write .*\/hbots\.service\.d\/50-no-swap\.conf/);
    assert.equal(fs.existsSync(path.join(home, ".config")), false);
    assert.equal(calls, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
