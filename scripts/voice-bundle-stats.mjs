// Lists the built chunks that matter to the voice feature, grouped by their
// name without the content hash, with raw and gzip sizes. Used to compare a
// branch tip with its base: node scripts/voice-bundle-stats.mjs <distDir>
import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "apps/web/dist/assets";
const name = (file) => file.replace(/-[A-Za-z0-9_-]{8}\.js$/, "");
const wanted = (base) =>
  /voice|Voice/.test(base) ||
  base.startsWith("_personal.bots_._botId._threadId") ||
  base.startsWith("_personal-") ||
  base.startsWith("ComposerPromptEditor");

const rows = [];
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".js")) continue;
  const base = name(file);
  if (!wanted(base)) continue;
  const body = readFileSync(join(dir, file));
  rows.push({
    chunk: base,
    kB: Number((body.length / 1024).toFixed(2)),
    gzipKb: Number((gzipSync(body).length / 1024).toFixed(2)),
  });
}
rows.sort((a, b) => a.chunk.localeCompare(b.chunk));
for (const row of rows) {
  console.log(
    `${row.chunk.padEnd(44)} ${String(row.kB).padStart(8)} kB  ${String(row.gzipKb).padStart(7)} kB gzip`,
  );
}
const total = rows.reduce(
  (sum, row) => ({ kB: sum.kB + row.kB, gzipKb: sum.gzipKb + row.gzipKb }),
  { kB: 0, gzipKb: 0 },
);
console.log(
  `TOTAL (${rows.length} chunks)`.padEnd(44) +
    `${total.kB.toFixed(2).padStart(8)} kB  ${total.gzipKb.toFixed(2).padStart(7)} kB gzip`,
);
