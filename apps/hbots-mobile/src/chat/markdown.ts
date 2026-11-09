/**
 * Turns markdown into the shapes a native `Text` draws: paragraphs, headings,
 * bold, italic, inline and fenced code, lists, quotes and GitHub tables.
 * Anything else stays literal.
 */

export interface FileLink {
  readonly path: string;
  readonly label: string;
  /** The last path segment, drawn in the chip. */
  readonly name: string;
}

export type InlineSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "italic"; readonly text: string }
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

/** A code span that names a file rather than code: a path with a separator. */
function pathLike(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 2 &&
    !trimmed.includes("\n") &&
    /[/\\]/u.test(trimmed) &&
    !/^[a-z]+:\/\//iu.test(trimmed) &&
    linkTarget(trimmed).kind === "file"
  );
}

function fileLink(path: string, label: string): { readonly kind: "file" } & FileLink {
  return { kind: "file", path, label, name: fileBasename(path) || label };
}

function inline(text: string): ReadonlyArray<InlineSpan> {
  const spans: InlineSpan[] = [];
  const pattern =
    /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\))/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ kind: "text", text: text.slice(last, index) });
    const token = match[0];
    const link = LINK.exec(token);
    if (link !== null) {
      const label = link[1] ?? "";
      const href = link[2] ?? "";
      const target = linkTarget(href);
      spans.push(
        target.kind === "file" ? fileLink(target.path, label) : { kind: "link", text: label, href },
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      const code = token.slice(1, -1);
      spans.push(pathLike(code) ? fileLink(code.trim(), code) : { kind: "code", text: code });
    } else {
      spans.push({ kind: "italic", text: token.slice(1, -1) });
    }
    last = index + token.length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
  return spans.length === 0 ? [{ kind: "text", text }] : spans;
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

export function markdownBlocks(source: string): ReadonlyArray<MarkdownBlock> {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: { language: string; lines: string[] } | null = null;

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
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      code = { language: fence[1] ?? "", lines: [] };
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      const text = heading[2] ?? "";
      const spans = inline(text);
      blocks.push({ kind: "heading", spans, text, ...fileFields(spans) });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      const text = quote[1] ?? "";
      const spans = inline(text);
      blocks.push({ kind: "quote", spans, text, ...fileFields(spans) });
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
      continue;
    }
    const table = tableAt(lines, index);
    if (table !== null) {
      flushParagraph();
      blocks.push({ kind: "table", table: table.table });
      index = table.last;
      continue;
    }
    paragraph.push(line);
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
  return blocks;
}

/**
 * Lists and code blocks put a flexing column inside a shrink-to-fit bubble, and
 * a table puts a horizontal scroll there. Android lays that out during an
 * unclamped intrinsic pass, so it collapses. Those messages need a definite width.
 */
export function markdownNeedsWidth(source: string): boolean {
  return markdownBlocks(source).some((block) => {
    if (
      block.kind === "bullet" ||
      block.kind === "number" ||
      block.kind === "code" ||
      block.kind === "table"
    ) {
      return true;
    }
    return block.files !== undefined || block.spans.some((span) => span.kind === "file");
  });
}

/**
 * Where a markdown link goes. A file path opens in the file sheet. Only http
 * and https leave the app: other schemes such as tel: or javascript: are shown
 * as plain text, because a bot's reply must not hand them to the system.
 */
export function linkTarget(
  href: string,
):
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "blocked" } {
  const trimmed = href.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return { kind: "file", path: trimmed };
  if (/^https?:\/\//iu.test(trimmed)) return { kind: "external", url: trimmed };
  if (trimmed.startsWith("//")) return { kind: "external", url: `https:${trimmed}` };
  if (/^file:\/\//iu.test(trimmed)) {
    const withoutScheme = decodeURIComponent(trimmed.replace(/^file:\/\//iu, ""));
    return { kind: "file", path: withoutScheme.replace(/^\/(?=[A-Za-z]:[\\/])/u, "") };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return { kind: "blocked" };
  return { kind: "file", path: trimmed };
}
