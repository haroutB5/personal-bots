// Deterministic hash of a directory tree for the release seal. Read-only, never prints file contents.
// Library: treeHash(dir). CLI: node hash.mjs <dir>  ->  {"files","bytes","newestMtimeMs","sha256"}
// The hash covers every file's relative path (forward slashes, sorted ordinally) and SHA-256. Symlinks are
// recorded as "L:<target>" and never followed, so a release's node_modules cannot drag in a checkout.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export function treeHash(root) {
  const entries = [];
  let bytes = 0;
  let newest = 0;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      const st = fs.lstatSync(full);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (st.isSymbolicLink()) entries.push([rel, `L:${fs.readlinkSync(full)}`]);
      else if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        bytes += st.size;
        entries.push([rel, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
      } else entries.push([rel, `O:${st.mode & 0o170000}`]);
    }
  };
  walk(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const body = entries.map((e) => `${e[0]}\t${e[1]}`).join("\n");
  return { files: entries.length, bytes, newestMtimeMs: Math.round(newest), sha256: crypto.createHash("sha256").update(body).digest("hex") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: hash.mjs <dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(treeHash(dir)));
}
