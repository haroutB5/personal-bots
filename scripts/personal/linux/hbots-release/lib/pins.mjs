// Pinned reviewed helpers. PINS.json (written by install.sh after review) holds the SHA-256 of the helper
// files the runner imports or executes plus the dev-team check tools it calls. A changed file refuses the run.
import fs from "node:fs";
import path from "node:path";
import { readJson, sha256File, atomicWrite } from "./util.mjs";

const LOCAL = ["lib/hash.mjs", "lib/dbcheck.mjs", "lib/fixture.mjs", "lib/idle.mjs", "lib/backup.mjs", "lib/seal.mjs"];
const TOOLS = ["check-release-notes.mjs", "check-gate-evidence.mjs", "gate-common.mjs", "ops-common.mjs", "notify-release.mjs"];

export function currentPins(cfg) {
  const files = {};
  for (const rel of LOCAL) files[rel] = sha256File(path.join(cfg.here, rel));
  for (const name of TOOLS) files[`tools/${name}`] = sha256File(path.join(cfg.toolsDir, name));
  return { schema: 1, files };
}

export function writePins(cfg) {
  const pins = currentPins(cfg);
  atomicWrite(cfg.pinsFile, `${JSON.stringify(pins, null, 2)}\n`);
  return pins;
}

export function checkPins(cfg) {
  const pinned = readJson(cfg.pinsFile);
  if (!pinned?.files) throw new Error(`No PINS.json at ${cfg.pinsFile}; run install.sh (or --write-pins after review).`);
  const now = currentPins(cfg);
  for (const [name, sha] of Object.entries(pinned.files)) {
    if (now.files[name] !== sha) throw new Error(`Helper ${name} differs from the pinned hash.`);
  }
  for (const name of Object.keys(now.files)) if (!pinned.files[name]) throw new Error(`Helper ${name} is not pinned.`);
  return Object.keys(pinned.files).length;
}
