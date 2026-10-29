import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
