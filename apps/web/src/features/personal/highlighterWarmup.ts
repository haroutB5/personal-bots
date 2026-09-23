import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { perfOptimizationOn, whenIdle } from "./perfFlags";

/**
 * A few typical lines per language the bots write most. The first time a
 * grammar tokenizes, the regex engine compiles its rules: measured with the
 * app's shiki, 15 lines of TypeScript took 100 ms the first time and 5 ms the
 * second (desktop CPU; 4x that on the throttled bench, where a reply's first
 * code block froze the chat for 700-900 ms). Tokenizing these samples while
 * the reply is being written (ConversationScreen calls this on send) pays
 * that compile before a reply needs it, and never while the user is typing.
 */
const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  [
    "typescript",
    'import { readFile } from "node:fs/promises";\n' +
      "export interface Row { readonly id: string; count: number }\n" +
      "export async function load(path: string): Promise<Row[]> {\n" +
      '  const text = await readFile(path, "utf8");\n' +
      "  return JSON.parse(text).map((row: Row, i: number) => ({ ...row, count: i * 2 }));\n" +
      "}\n" +
      "const total = rows.reduce((sum, row) => sum + row.count, 0); // sum\n",
  ],
  [
    "tsx",
    "export function Card({ title }: { title: string }) {\n" +
      '  return <div className="card">{title && <h2>{title}</h2>}</div>;\n' +
      "}\n",
  ],
  [
    "python",
    "import json\n" +
      "from pathlib import Path\n\n" +
      "def load(path: str) -> list[dict]:\n" +
      '    """Read rows."""\n' +
      '    rows = json.loads(Path(path).read_text(encoding="utf-8"))\n' +
      '    return [dict(r, count=i * 2) for i, r in enumerate(rows) if r.get("id")]\n' +
      "print(f\"{len(load('x.json'))} rows\")  # done\n",
  ],
  [
    "bash",
    "#!/usr/bin/env bash\n" +
      "set -euo pipefail\n" +
      'for f in "$DIR"/*.log; do\n' +
      '  count=$(grep -c "ERROR" "$f" || true)\n' +
      '  echo "$f: ${count}" | tee -a report.txt\n' +
      "done\n",
  ],
  ["json", '{ "id": "a1", "count": 3, "tags": ["x", "y"], "ok": true, "none": null }\n'],
];

let started = false;

/**
 * Compiles the common grammars one language per idle callback, once per page
 * load. Kill switch: "warm-highlighter" (perfFlags.ts). Returns a cancel
 * function that stops any languages not yet warmed.
 */
export function warmHighlighterWhenIdle(): () => void {
  if (started || !perfOptimizationOn("warm-highlighter")) return () => undefined;
  started = true;
  const theme = resolveDiffThemeName("dark");
  let stopped = false;
  let cancelIdle: () => void = () => undefined;
  const warm = (index: number) => {
    const sample = SAMPLES[index];
    if (stopped || sample === undefined) return;
    cancelIdle = whenIdle(() => {
      const [language, code] = sample;
      void getSyntaxHighlighterPromise(language)
        .then((highlighter) => {
          if (stopped) return;
          try {
            highlighter.codeToHast(code, { lang: language, theme });
          } catch {
            // A language the bundle lacks just stays cold.
          }
        })
        .catch(() => undefined)
        .finally(() => warm(index + 1));
    });
  };
  warm(0);
  return () => {
    stopped = true;
    cancelIdle();
  };
}

/** Test hook. */
export function resetHighlighterWarmupForTest(): void {
  started = false;
}
