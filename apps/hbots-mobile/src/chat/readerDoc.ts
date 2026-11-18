import { markdownBlocks, type InlineSpan, type MarkdownBlock } from "./markdown";

/** A word the second tap landed on: the text of its on-screen block and the character offset. */
export type TextHit = { readonly text: string; readonly offset: number };

export type ReaderStyle = "plain" | "bold" | "italic" | "code" | "link" | "heading" | "codeBlock";
export type ReaderRun = { readonly text: string; readonly style: ReaderStyle };
/** `text` is exactly what Select all copies: the concatenation of `runs`. */
export type ReaderDoc = { readonly text: string; readonly runs: ReadonlyArray<ReaderRun> };

/** How much text on each side of the tapped offset identifies it in the document. */
const ANCHOR_RADIUS = 30;

function spanRuns(spans: ReadonlyArray<InlineSpan>, base: ReaderStyle): ReaderRun[] {
  const runs: ReaderRun[] = [];
  for (const span of spans) {
    switch (span.kind) {
      case "text":
        runs.push({ text: span.text, style: base });
        break;
      case "bold":
      case "italic":
        if (span.spans !== undefined) runs.push(...spanRuns(span.spans, span.kind));
        else runs.push({ text: span.text, style: span.kind });
        break;
      case "code":
        runs.push({ text: span.text, style: "code" });
        break;
      case "link":
        runs.push({ text: span.text, style: "link" });
        break;
      case "file":
        runs.push({ text: span.label, style: "link" });
        break;
    }
  }
  return runs;
}

function blockRuns(block: MarkdownBlock): ReaderRun[] {
  switch (block.kind) {
    case "heading":
      return spanRuns(block.spans, "heading");
    case "paragraph":
    case "quote":
      return spanRuns(block.spans, "plain");
    case "bullet":
    case "number": {
      const marker = block.kind === "bullet" ? "•" : `${block.marker}.`;
      return [
        { text: `${"  ".repeat(block.depth)}${marker} `, style: "plain" },
        ...spanRuns(block.spans, "plain"),
      ];
    }
    case "code":
      return [{ text: block.text, style: "codeBlock" }];
    case "table": {
      const rows = [block.table.header, ...block.table.rows];
      return rows.flatMap((row, rowIndex) => [
        ...(rowIndex > 0 ? [{ text: "\n", style: "plain" as const }] : []),
        ...row.flatMap((cell, cellIndex) => [
          ...(cellIndex > 0 ? [{ text: "\t", style: "plain" as const }] : []),
          ...spanRuns(cell.spans, "plain"),
        ]),
      ]);
    }
  }
}

/** The message as the reader draws it: markers stripped, blocks separated by a blank line. */
export function readerDoc(markdown: string): ReaderDoc {
  const runs: ReaderRun[] = [];
  markdownBlocks(markdown).forEach((block, index) => {
    if (index > 0) runs.push({ text: "\n\n", style: "plain" });
    runs.push(...blockRuns(block));
  });
  return { text: runs.map((run) => run.text).join(""), runs };
}

/**
 * Where the tapped word sits in the reader text. The hit carries the on-screen
 * text of one block, which the reader may draw with a marker prefix, so the
 * window around the offset is searched for rather than the whole block.
 */
export function anchorOffset(doc: ReaderDoc, hit: TextHit): number | null {
  if (hit.offset < 0 || hit.offset > hit.text.length) return null;
  const start = Math.max(0, hit.offset - ANCHOR_RADIUS);
  const window = hit.text.slice(start, Math.min(hit.text.length, hit.offset + ANCHOR_RADIUS));
  if (window.length === 0) return null;
  const found = doc.text.indexOf(window);
  return found < 0 ? null : found + (hit.offset - start);
}
