import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { getPaths, defaultPort, isValidRootName } from "../lib/paths.mjs";
import { backupStamp } from "../lib/util.mjs";
import { selectPrunable, removeReleaseDir, setActiveRelease } from "../lib/release.mjs";

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hbots-paths-"));
}

test("paths keep the PowerShell layout", () => {
  const home = tempHome();
  const paths = getPaths({ root: "dev", home });
  assert.equal(paths.baseDir, path.join(home, "dev"));
  assert.equal(paths.stateDir, path.join(home, "dev", "userdata"));
  assert.equal(paths.currentFile, path.join(home, "releases", "current.txt"));
  assert.equal(paths.backupsDir, path.join(home, "backups"));
  assert.equal(defaultPort("dev"), 38472);
  assert.equal(defaultPort("prod"), 38473);
});

test("root names reject traversal", () => {
  assert.equal(isValidRootName("dev"), true);
  assert.equal(isValidRootName("../etc"), false);
  assert.equal(isValidRootName(""), false);
});

test("backup stamps sort chronologically", () => {
  assert.match(backupStamp(new Date("2026-10-25T09:08:07")), /^\d{8}-\d{6}$/);
});

test("pruning keeps newest, active, running and protected releases", () => {
  const home = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  const names = ["a", "b", "c", "d"];
  names.forEach((name, index) => {
    const dir = path.join(paths.releasesDir, name);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "bin.mjs"), "//");
    const time = new Date(Date.now() - index * 60000);
    fs.utimesSync(dir, time, time);
  });
  fs.writeFileSync(paths.currentFile, "a\n");
  const prunable = selectPrunable({ paths, keep: 1, protect: ["d"], running: "c" });
  assert.deepEqual(prunable.sort(), ["b"]);
});

test("removing a release unlinks a symlinked node_modules without following it", () => {
  const home = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  const checkout = path.join(home, "checkout-modules");
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(checkout, "keep.txt"), "keep");
  const release = path.join(paths.releasesDir, "r1");
  fs.mkdirSync(path.join(release, "dist"), { recursive: true });
  fs.symlinkSync(checkout, path.join(release, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  removeReleaseDir(release);
  assert.equal(fs.existsSync(release), false);
  assert.equal(fs.existsSync(path.join(checkout, "keep.txt")), true);
});

test("activating a release requires a real bin", () => {
  const home = tempHome();
  const paths = getPaths({ home });
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  assert.throws(() => setActiveRelease(paths, "nope"), /no dist\/bin\.mjs/);
  fs.mkdirSync(path.join(paths.releasesDir, "ok", "dist"), { recursive: true });
  fs.writeFileSync(path.join(paths.releasesDir, "ok", "dist", "bin.mjs"), "//");
  setActiveRelease(paths, "ok");
  assert.equal(fs.readFileSync(paths.currentFile, "utf8").trim(), "ok");
});
