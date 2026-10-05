// node scripts/personal/adblock/extract-domains.mjs <lists dir>   (needs easylist.txt, easyprivacy.txt, pgl.txt in it)
import fs from "node:fs";
const out = new Set();
let total = 0,
  kept = 0;
const okOpts = new Set([
  "third-party",
  "3p",
  "script",
  "image",
  "xmlhttprequest",
  "xhr",
  "subdocument",
  "ping",
  "other",
  "stylesheet",
  "media",
  "font",
  "websocket",
  "object",
  "~inline-script",
  "all",
  "important",
]);
for (const f of ["easylist.txt", "easyprivacy.txt"]) {
  for (const raw of fs.readFileSync(process.argv[2] + "/" + f, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line.startsWith("||") ||
      line.includes("##") ||
      line.includes("#@#") ||
      line.includes("#?#") ||
      line.startsWith("@@")
    )
      continue;
    total++;
    const m = line.match(/^\|\|([a-z0-9.-]+)\^?(\$.*)?$/i);
    if (!m) continue; // has path / wildcard
    const host = m[1].toLowerCase();
    if (!host.includes(".") || /^\d+\.\d+/.test(host)) continue;
    if (m[2]) {
      const opts = m[2].slice(1).split(",");
      if (opts.some((o) => !okOpts.has(o))) continue; // domain=, popup, redirect, etc.
    }
    kept++;
    out.add(host);
  }
}
for (const l of fs.readFileSync(process.argv[2] + "/pgl.txt", "utf8").split(/\r?\n/)) {
  const h = l.trim().toLowerCase();
  if (h && !h.startsWith("#") && h.includes(".")) out.add(h);
}
fs.writeFileSync(process.argv[2] + "/domains-full.txt", [...out].sort().join("\n") + "\n");
console.log({ total, kept, unique: out.size });
