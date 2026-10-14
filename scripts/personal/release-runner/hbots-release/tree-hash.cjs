// Deterministic hash of a directory tree for the hbots release runner. Read-only, no secrets printed.
// Usage: node tree-hash.cjs <dir> [--list <file>]
// Prints one JSON line: {"files":n,"bytes":n,"newestMtimeMs":n,"sha256":"..."}
// The hash covers every file's relative path (forward slashes, sorted ordinally) and SHA-256. Symlinks and
// junctions are recorded as "L:<target>" and never followed (a release's node_modules must not drag in a checkout).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = process.argv[2];
if (!root) { console.error("usage: tree-hash.cjs <dir>"); process.exit(2); }
const listIdx = process.argv.indexOf("--list");
const listFile = listIdx > 0 ? process.argv[listIdx + 1] : null;

const entries = [];
let bytes = 0;
let newest = 0;
function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    const st = fs.lstatSync(full);
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (d.isSymbolicLink() || st.isSymbolicLink()) {
      entries.push([rel, "L:" + fs.readlinkSync(full)]);
    } else if (d.isDirectory()) {
      walk(full);
    } else if (d.isFile()) {
      bytes += st.size;
      entries.push([rel, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    } else {
      entries.push([rel, "O:" + (st.mode & 0o170000)]);
    }
  }
}
walk(root);
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const body = entries.map((e) => e[0] + "\t" + e[1]).join("\n");
if (listFile) fs.writeFileSync(listFile, body + "\n");
console.log(JSON.stringify({
  files: entries.length,
  bytes,
  newestMtimeMs: Math.round(newest),
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
}));
