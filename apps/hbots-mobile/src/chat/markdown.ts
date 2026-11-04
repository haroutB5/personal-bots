/**
 * Turns the markdown a bot writes into the spans a native `Text` draws. The
 * web renders full markdown; a phone chat needs the shapes that change how a
 * reply reads: paragraphs, headings, bold, italic, inline and fenced code,
 * bullets and numbered lists. Anything else stays literal.
 */

export type InlineSpan =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "italic"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

export interface MarkdownBlock {
  readonly kind: "paragraph" | "heading" | "bullet" | "number" | "code" | "quote";
  readonly spans: ReadonlyArray<InlineSpan>;
  readonly text: string;
  readonly marker?: string;
  readonly language?: string;
  /** 0 for a top-level list item, 1 for a nested one, and so on. */
  readonly depth?: number;
}

const FENCE = /^```([\w-]*)\s*$/u;
const HEADING = /^(#{1,4})\s+(.*)$/u;
const BULLET = /^( *)[-*+]\s+(.*)$/u;
const NUMBER = /^( *)(\d+)[.)]\s+(.*)$/u;
const QUOTE = /^>\s?(.*)$/u;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u;
const MAX_LIST_DEPTH = 3;

function listDepth(spaces: string): number {
  return Math.min(MAX_LIST_DEPTH, Math.floor(spaces.length / 2));
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
      spans.push({ kind: "link", text: link[1] ?? "", href: link[2] ?? "" });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else {
      spans.push({ kind: "italic", text: token.slice(1, -1) });
    }
    last = index + token.length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
  return spans.length === 0 ? [{ kind: "text", text }] : spans;
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
    if (text.length > 0) blocks.push({ kind: "paragraph", spans: inline(text), text });
  };

  for (const line of lines) {
    if (code !== null) {
      if (FENCE.test(line)) {
        const text = code.lines.join("\n");
        blocks.push({
          kind: "code",
          spans: [{ kind: "text", text }],
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
      blocks.push({ kind: "heading", spans: inline(text), text });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flushParagraph();
      const text = quote[1] ?? "";
      blocks.push({ kind: "quote", spans: inline(text), text });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushParagraph();
      const text = bullet[2] ?? "";
      blocks.push({
        kind: "bullet",
        spans: inline(text),
        text,
        marker: "•",
        depth: listDepth(bullet[1] ?? ""),
      });
      continue;
    }
    const number = NUMBER.exec(line);
    if (number !== null) {
      flushParagraph();
      const text = number[3] ?? "";
      blocks.push({
        kind: "number",
        spans: inline(text),
        text,
        marker: number[2] ?? "1",
        depth: listDepth(number[1] ?? ""),
      });
      continue;
    }
    paragraph.push(line);
  }
  if (code !== null) {
    const text = code.lines.join("\n");
    blocks.push({
      kind: "code",
      spans: [{ kind: "text", text }],
      text,
      ...(code.language.length > 0 ? { language: code.language } : {}),
    });
  }
  flushParagraph();
  return blocks;
}

/**
 * Lists and code blocks put a flexing column inside a shrink-to-fit bubble.
 * Android lays that out during an unclamped intrinsic pass, so the column
 * collapses and later rows overlap. Those messages need a definite width.
 */
export function markdownNeedsWidth(source: string): boolean {
  return markdownBlocks(source).some(
    (block) => block.kind === "bullet" || block.kind === "number" || block.kind === "code",
  );
}

/**
 * Where a markdown link goes: an absolute address opens outside the app, and
 * anything else is a chat file, as on the web. A `#fragment` and a `?query`
 * stay with the path because the file sheet resolves the path only.
 */
export function linkTarget(
  href: string,
):
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "file"; readonly path: string } {
  const trimmed = href.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return { kind: "file", path: trimmed };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed) || trimmed.startsWith("//")) {
    return { kind: "external", url: trimmed };
  }
  return { kind: "file", path: trimmed };
}
