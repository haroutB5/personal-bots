/**
 * Turns markdown into the shapes a native `Text` draws: paragraphs, headings,
 * bold, italic, inline and fenced code, lists, quotes and GitHub tables.
 * Anything else stays literal.
 */

import {
  INLINE_TOKEN,
  linkTarget,
  MAX_INLINE_DEPTH,
  pathLike,
  shieldIntrawordUnderscores,
  unshieldUnderscores,
} from "@t3tools/shared/messageFileLinks";

export { linkTarget };

export interface FileLink {
  readonly path: string;
  readonly label: string;
  /** The last path segment, drawn in the chip. */
  readonly name: string;
}

export type InlineSpan =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "bold";
      readonly text: string;
      /** The parsed inner spans, set only when the inner text carries markup. */
      readonly spans?: ReadonlyArray<InlineSpan>;
    }
  | {
      readonly kind: "italic";
      readonly text: string;
      /** The parsed inner spans, set only when the inner text carries markup. */
      readonly spans?: ReadonlyArray<InlineSpan>;
    }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  | ({ readonly kind: "file" } & FileLink);

export type TableAlign = "left" | "center" | "right";

export interface MarkdownCell {
  readonly spans: ReadonlyArray<InlineSpan>;
  readonly text: string;
}

export interface MarkdownTable {
  readonly header: ReadonlyArray<MarkdownCell>;
  readonly aligns: ReadonlyArray<TableAlign>;
  readonly rows: ReadonlyArray<ReadonlyArray<MarkdownCell>>;
}

export type MarkdownBlock =
  | {
      readonly kind: "paragraph" | "heading" | "quote";
      readonly spans: ReadonlyArray<InlineSpan>;
      readonly text: string;
      /** Set when the block is nothing but file links, so it renders as chips. */
      readonly files?: ReadonlyArray<FileLink>;
    }
  | {
      readonly kind: "bullet" | "number";
      readonly spans: ReadonlyArray<InlineSpan>;
      readonly text: string;
      readonly marker: string;
      /** 0 for a top-level list item, 1 for a nested one, and so on. */
      readonly depth: number;
      readonly files?: ReadonlyArray<FileLink>;
    }
  | { readonly kind: "code"; readonly text: string; readonly language?: string }
  | { readonly kind: "table"; readonly table: MarkdownTable };

const FENCE = /^```([\w-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const TABLE_DELIMITER = /^:?-+:?$/u;
const BULLET = /^( *)[-*+]\s+(.*)$/u;
const NUMBER = /^( *)(\d+)[.)]\s+(.*)$/u;
const QUOTE = /^>\s?(.*)$/u;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u;
const MAX_LIST_DEPTH = 3;

function listDepth(spaces: string): number {
  return Math.min(MAX_LIST_DEPTH, Math.floor(spaces.length / 2));
}

/** Whether a line has a pipe that separates table cells rather than escaped text. */
function hasTablePipe(line: string): boolean {
  let slashes = 0;
  for (const char of line) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === "|" && slashes % 2 === 0) return true;
    slashes = 0;
  }
  return false;
}

/** Splits a table row on unescaped pipes and drops the optional outer pipes. */
function tableRow(line: string): ReadonlyArray<string> | null {
  const trimmed = line.trim();
  if (!hasTablePipe(trimmed)) return null;
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    if (char === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  if (trimmed.startsWith("|") && cells.length > 1) cells.shift();
  if (cells.length > 1 && (cells.at(-1) ?? "").trim().length === 0) cells.pop();
  return cells.map((value) => value.trim());
}

function tableAligns(line: string): ReadonlyArray<TableAlign> | null {
  const cells = tableRow(line);
  if (cells === null) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!TABLE_DELIMITER.test(cell)) return null;
    aligns.push(
      cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
    );
  }
  return aligns;
}

function tableCell(text: string): MarkdownCell {
  return { text, spans: inline(text) };
}

function tableAt(
  lines: ReadonlyArray<string>,
  start: number,
): { readonly table: MarkdownTable; readonly last: number } | null {
  const headerLine = lines[start] ?? "";
  const delimiterLine = lines[start + 1];
  if (delimiterLine === undefined || !hasTablePipe(headerLine)) return null;
  const header = tableRow(headerLine);
  const aligns = tableAligns(delimiterLine);
  if (header === null || aligns === null || header.length !== aligns.length) return null;
  const rows: MarkdownCell[][] = [];
  let last = start + 1;
  for (let index = start + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || !hasTablePipe(line)) break;
    const cells = tableRow(line) ?? [];
    rows.push(aligns.map((_, column) => tableCell(cells[column] ?? "")));
    last = index;
  }
  return {
    table: { header: header.map(tableCell), aligns, rows },
    last,
  };
}

function fileBasename(path: string): string {
  return (
    path
      .split(/[\\/]/u)
      .filter((part) => part.length > 0)
      .at(-1) ?? path
  );
}

function fileLink(path: string, label: string): { readonly kind: "file" } & FileLink {
  return { kind: "file", path, label, name: fileBasename(path) || label };
}

const HAS_INLINE_SYNTAX = /[*_`[]/;

function inline(text: string, depth = 0): ReadonlyArray<InlineSpan> {
  if (!HAS_INLINE_SYNTAX.test(text)) {
    if (!text.includes("://")) return [{ kind: "text", text }];
    const spans: InlineSpan[] = [];
    pushTextWithAddresses(spans, text);
    return spans.length === 0 ? [{ kind: "text", text }] : spans;
  }
  const source = shieldIntrawordUnderscores(text);
  const spans: InlineSpan[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      pushTextWithAddresses(spans, unshieldUnderscores(source.slice(last, index)));
    }
    const token = match[0];
    const link = LINK.exec(token);
    if (link !== null) {
      const label = unshieldUnderscores(link[1] ?? "");
      const href = unshieldUnderscores(link[2] ?? "");
      const target = linkTarget(href);
      spans.push(
        target.kind === "file" ? fileLink(target.path, label) : { kind: "link", text: label, href },
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push(emphasis("bold", token.slice(2, -2), depth));
    } else if (token.startsWith("`")) {
      const code = unshieldUnderscores(token.slice(1, -1));
      spans.push(pathLike(code) ? fileLink(code.trim(), code) : { kind: "code", text: code });
    } else {
      spans.push(emphasis("italic", token.slice(1, -1), depth));
    }
    last = index + token.length;
  }
  if (last < source.length) {
    pushTextWithAddresses(spans, unshieldUnderscores(source.slice(last)));
  }
  return spans.length === 0 ? [{ kind: "text", text }] : spans;
}

/** A web address written out in plain text. Only http and https count. */
const BARE_ADDRESS = /https?:\/\/[^\s<>]+/giu;
const ADDRESS_TRAILING_PUNCTUATION = /[.,;:!?'"*_~]$/u;
const CLOSERS: ReadonlyArray<readonly [string, string]> = [
  [")", "("],
  ["]", "["],
  ["}", "{"],
];

function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

/**
 * Where a written-out address really ends: sentence punctuation after it is
 * not part of it, and a closing bracket is only when the address opened one.
 */
function trimAddress(candidate: string): string {
  let address = candidate;
  for (;;) {
    if (ADDRESS_TRAILING_PUNCTUATION.test(address)) {
      address = address.slice(0, -1);
      continue;
    }
    const closer = CLOSERS.find(([close]) => address.endsWith(close));
    if (closer !== undefined && count(address, closer[0]) > count(address, closer[1])) {
      address = address.slice(0, -1);
      continue;
    }
    return address;
  }
}

/** Adds plain text, turning each written-out http or https address into a link. */
function pushTextWithAddresses(spans: InlineSpan[], text: string): void {
  if (!text.includes("://")) {
    if (text.length > 0) spans.push({ kind: "text", text });
    return;
  }
  let last = 0;
  for (const match of text.matchAll(BARE_ADDRESS)) {
    const index = match.index ?? 0;
    const previous = index === 0 ? "" : (text[index - 1] ?? "");
    // "xhttps://" is a word that happens to contain the letters, not an address.
    if (/[\p{L}\p{N}]/u.test(previous)) continue;
    const address = trimAddress(match[0]);
    if (!/^https?:\/\/[^/?#]/iu.test(address)) continue;
    if (index > last) spans.push({ kind: "text", text: text.slice(last, index) });
    spans.push({ kind: "link", text: address, href: address });
    last = index + address.length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
}

/**
 * Bold or italic text. When the inner text carries its own markup (code, a
 * link, or the other emphasis), it keeps the parsed children so each of them
 * draws with the inherited weight. Plain runs stay a single `text` string.
 */
function emphasis(kind: "bold" | "italic", inner: string, depth: number): InlineSpan {
  const literal = unshieldUnderscores(inner);
  if (depth >= MAX_INLINE_DEPTH) return { kind, text: literal };
  const spans = inline(inner, depth + 1);
  const plain = spans.length === 1 && spans[0]?.kind === "text";
  return plain ? { kind, text: literal } : { kind, text: literal, spans };
}

/** Whether a span list holds a file link, at any depth of bold or italic. */
export function hasFileSpan(spans: ReadonlyArray<InlineSpan>): boolean {
  return spans.some((span) => {
    if (span.kind === "file") return true;
    if (span.kind === "bold" || span.kind === "italic") {
      return span.spans !== undefined && hasFileSpan(span.spans);
    }
    return false;
  });
}

/**
 * A block is a file list when every non-blank span is a file. Those render as
 * chips, as the web does, instead of a run of underlined labels.
 */
function fileFields(spans: ReadonlyArray<InlineSpan>): {
  readonly files?: ReadonlyArray<FileLink>;
} {
  const files: FileLink[] = [];
  for (const span of spans) {
    if (span.kind === "text") {
      if (span.text.trim().length > 0) return {};
      continue;
    }
    if (span.kind !== "file") return {};
    files.push({ path: span.path, label: span.label, name: span.name });
  }
  return files.length > 0 ? { files } : {};
}

function sameFileLinks(
  a: ReadonlyArray<FileLink> | undefined,
  b: ReadonlyArray<FileLink> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (left.path !== right.path || left.label !== right.label || left.name !== right.name) {
      return false;
    }
  }
  return true;
}

function sameInlineSpan(a: InlineSpan, b: InlineSpan): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "text":
    case "code":
      return a.text === (b as typeof a).text;
    case "link": {
      const right = b as typeof a;
      return a.text === right.text && a.href === right.href;
    }
    case "file": {
      const right = b as typeof a;
      return a.path === right.path && a.label === right.label && a.name === right.name;
    }
    case "bold":
    case "italic": {
      const right = b as typeof a;
      return a.text === right.text && sameInlineSpans(a.spans, right.spans);
    }
  }
}

function sameInlineSpans(
  a: ReadonlyArray<InlineSpan> | undefined,
  b: ReadonlyArray<InlineSpan> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!sameInlineSpan(a[i]!, b[i]!)) return false;
  }
  return true;
}

function sameMarkdownCell(a: MarkdownCell, b: MarkdownCell): boolean {
  return a === b || (a.text === b.text && sameInlineSpans(a.spans, b.spans));
}

function sameMarkdownTable(a: MarkdownTable, b: MarkdownTable): boolean {
  if (a === b) return true;
  if (
    a.header.length !== b.header.length ||
    a.aligns.length !== b.aligns.length ||
    a.rows.length !== b.rows.length
  ) {
    return false;
  }
  for (let i = 0; i < a.aligns.length; i += 1) {
    if (a.aligns[i] !== b.aligns[i]) return false;
  }
  for (let i = 0; i < a.header.length; i += 1) {
    if (!sameMarkdownCell(a.header[i]!, b.header[i]!)) return false;
  }
  for (let r = 0; r < a.rows.length; r += 1) {
    const leftRow = a.rows[r]!;
    const rightRow = b.rows[r]!;
    if (leftRow === rightRow) continue;
    if (leftRow.length !== rightRow.length) return false;
    for (let c = 0; c < leftRow.length; c += 1) {
      if (!sameMarkdownCell(leftRow[c]!, rightRow[c]!)) return false;
    }
  }
  return true;
}

/** Same drawn content, so a block parsed again from grown text need not redraw. */
export function sameBlock(a: MarkdownBlock, b: MarkdownBlock): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "code") {
    const right = b as typeof a;
    return a.text === right.text && a.language === right.language;
  }
  if (a.kind === "table") {
    return sameMarkdownTable(a.table, (b as typeof a).table);
  }
  if (a.kind === "bullet" || a.kind === "number") {
    const right = b as typeof a;
    return (
      a.text === right.text &&
      a.marker === right.marker &&
      a.depth === right.depth &&
      sameFileLinks(a.files, right.files) &&
      sameInlineSpans(a.spans, right.spans)
    );
  }
  const right = b as typeof a;
  return (
    a.text === right.text &&
    sameFileLinks(a.files, right.files) &&
    sameInlineSpans(a.spans, right.spans)
  );
}

interface ParsedMarkdownCacheEntry {
  readonly normalized: string;
  readonly blocks: ReadonlyArray<MarkdownBlock>;
  /** End offset (in `normalized`) of the last terminated blank line outside any code fence. */
  readonly safeOffset: number;
  readonly safeBlockCount: number;
}

const PARSED_CACHE_LIMIT = 12;
const parsedCache: ParsedMarkdownCacheEntry[] = [];

function parseNormalized(normalized: string): {
  readonly blocks: MarkdownBlock[];
  readonly safeOffset: number;
  readonly safeBlockCount: number;
} {
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: { language: string; lines: string[] } | null = null;
  let offset = 0;
  let safeOffset = 0;
  let safeBlockCount = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (text.length > 0) {
      const spans = inline(text);
      blocks.push({ kind: "paragraph", spans, text, ...fileFields(spans) });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextOffset = offset + line.length + (index < lines.length - 1 ? 1 : 0);
    if (code !== null) {
      if (FENCE.test(line)) {
        const text = code.lines.join("\n");
        blocks.push({
          kind: "code",
          text,
          ...(code.language.length > 0 ? { language: code.language } : {}),
        });
        code = null;
      } else {
        code.lines.push(line);
      }
      offset = nextOffset;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      code = { language: fence[1] ?? "", lines: [] };
      offset = nextOffset;
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      // A terminated blank line outside any fence resets parser state completely, so everything
      // before `nextOffset` is immutable when future streaming chunks append to this string.
      if (index < lines.length - 1) {
        safeOffset = nextOffset;
        safeBlockCount = blocks.length;
      }
      offset = nextOffset;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      const text = heading[2] ?? "";
      const spans = inline(text);
      blocks.push({ kind: "heading", spans, text, ...fileFields(spans) });
      offset = nextOffset;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      const text = quote[1] ?? "";
      const spans = inline(text);
      blocks.push({ kind: "quote", spans, text, ...fileFields(spans) });
      offset = nextOffset;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushParagraph();
      const text = bullet[2] ?? "";
      const spans = inline(text);
      blocks.push({
        kind: "bullet",
        spans,
        text,
        marker: "•",
        depth: listDepth(bullet[1] ?? ""),
        ...fileFields(spans),
      });
      offset = nextOffset;
      continue;
    }
    const number = NUMBER.exec(line);
    if (number !== null) {
      flushParagraph();
      const text = number[3] ?? "";
      const spans = inline(text);
      blocks.push({
        kind: "number",
        spans,
        text,
        marker: number[2] ?? "1",
        depth: listDepth(number[1] ?? ""),
        ...fileFields(spans),
      });
      offset = nextOffset;
      continue;
    }
    const table = tableAt(lines, index);
    if (table !== null) {
      flushParagraph();
      blocks.push({ kind: "table", table: table.table });
      for (let t = index; t <= table.last; t += 1) {
        offset += (lines[t] ?? "").length + (t < lines.length - 1 ? 1 : 0);
      }
      index = table.last;
      continue;
    }
    paragraph.push(line);
    offset = nextOffset;
  }
  if (code !== null) {
    const text = code.lines.join("\n");
    blocks.push({
      kind: "code",
      text,
      ...(code.language.length > 0 ? { language: code.language } : {}),
    });
  }
  flushParagraph();
  return { blocks, safeOffset, safeBlockCount };
}

function storeParsedCache(entry: ParsedMarkdownCacheEntry, replaceIndex?: number): void {
  if (replaceIndex !== undefined) {
    parsedCache.splice(replaceIndex, 1);
  } else if (parsedCache.length >= PARSED_CACHE_LIMIT) {
    parsedCache.shift();
  }
  parsedCache.push(entry);
}

export function markdownBlocks(source: string): ReadonlyArray<MarkdownBlock> {
  const normalized = source.includes("\r") ? source.replaceAll("\r\n", "\n") : source;
  let bestPrefixIdx = -1;
  let bestSafeOffset = 0;
  for (let i = parsedCache.length - 1; i >= 0; i -= 1) {
    const entry = parsedCache[i]!;
    if (entry.normalized === normalized) {
      return entry.blocks;
    }
    if (
      entry.safeOffset > bestSafeOffset &&
      normalized.length > entry.safeOffset &&
      normalized.startsWith(entry.normalized.slice(0, entry.safeOffset))
    ) {
      bestSafeOffset = entry.safeOffset;
      bestPrefixIdx = i;
    }
  }
  if (bestPrefixIdx !== -1) {
    const base = parsedCache[bestPrefixIdx]!;
    const tail = parseNormalized(normalized.slice(base.safeOffset));
    const blocks = [...base.blocks.slice(0, base.safeBlockCount), ...tail.blocks];
    storeParsedCache(
      {
        normalized,
        blocks,
        safeOffset: base.safeOffset + tail.safeOffset,
        safeBlockCount: base.safeBlockCount + tail.safeBlockCount,
      },
      bestPrefixIdx,
    );
    return blocks;
  }
  const parsed = parseNormalized(normalized);
  storeParsedCache({
    normalized,
    blocks: parsed.blocks,
    safeOffset: parsed.safeOffset,
    safeBlockCount: parsed.safeBlockCount,
  });
  return parsed.blocks;
}

/** Whether already-parsed markdown blocks need a definite bubble width on Android. */
export function blocksNeedWidth(blocks: ReadonlyArray<MarkdownBlock>): boolean {
  for (const block of blocks) {
    if (
      block.kind === "bullet" ||
      block.kind === "number" ||
      block.kind === "code" ||
      block.kind === "table"
    ) {
      return true;
    }
    if (block.files !== undefined || hasFileSpan(block.spans)) return true;
  }
  return false;
}

/**
 * Lists and code blocks put a flexing column inside a shrink-to-fit bubble, and
 * a table puts a horizontal scroll there. Android lays that out during an
 * unclamped intrinsic pass, so it collapses. Those messages need a definite width.
 */
export function markdownNeedsWidth(source: string): boolean {
  return blocksNeedWidth(markdownBlocks(source));
}
