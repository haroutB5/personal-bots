/**
 * One parser for the file links a chat draws, shared by the phone renderer and
 * the server's per-message read grant. A path the phone shows as a file is a
 * path the server accepts, and nothing else is.
 */

export type FileLinkTarget =
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "blocked" };

/**
 * Where a markdown link goes. A file path opens in the file sheet. Only http
 * and https leave the app: other schemes such as tel: or javascript: are shown
 * as plain text, because a bot's reply must not hand them to the system.
 */
export function linkTarget(href: string): FileLinkTarget {
  const trimmed = href.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return { kind: "file", path: trimmed };
  if (/^https?:\/\//iu.test(trimmed)) return { kind: "external", url: trimmed };
  if (trimmed.startsWith("//")) return { kind: "external", url: `https:${trimmed}` };
  if (/^file:\/\//iu.test(trimmed)) {
    let withoutScheme: string;
    try {
      withoutScheme = decodeURIComponent(trimmed.replace(/^file:\/\//iu, ""));
    } catch {
      // A malformed escape refuses this one link, not the whole message.
      return { kind: "blocked" };
    }
    return { kind: "file", path: withoutScheme.replace(/^\/(?=[A-Za-z]:[\\/])/u, "") };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return { kind: "blocked" };
  return { kind: "file", path: trimmed };
}

/** A code span that names a file rather than code: a path with a separator. */
export function pathLike(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 2 &&
    !trimmed.includes("\n") &&
    /[/\\]/u.test(trimmed) &&
    !/^[a-z]+:\/\//iu.test(trimmed) &&
    linkTarget(trimmed).kind === "file"
  );
}

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u;

/** The same inline token pattern the chat's markdown renderer runs. */
export const INLINE_TOKEN =
  /(\*\*(?:\*(?!\*)|[^*])+\*\*|__(?:_(?!_)|[^_])+__|\*(?![\s*])[^*\n]*[^\s*]\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\))/gu;

/** Mirrors the renderer's nesting limit for emphasis. */
export const MAX_INLINE_DEPTH = 4;

/** Stands in for an underscore CommonMark keeps literal; offsets stay equal. */
export const LITERAL_UNDERSCORE = "\uE000";

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/**
 * CommonMark keeps an underscore literal when a letter or digit sits on both
 * sides of the run, so `snake_case` never opens or closes emphasis. Swap those
 * underscores for a marker before parsing and restore them at extraction.
 */
export function shieldIntrawordUnderscores(text: string): string {
  if (!text.includes("_")) return text;
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "_") {
      result += text[index];
      continue;
    }
    let end = index;
    while (text[end + 1] === "_") end += 1;
    const literal = isWordChar(text[index - 1]) && isWordChar(text[end + 1]);
    result += (literal ? LITERAL_UNDERSCORE : "_").repeat(end - index + 1);
    index = end;
  }
  return result;
}

export function unshieldUnderscores(text: string): string {
  return text.includes(LITERAL_UNDERSCORE) ? text.replaceAll(LITERAL_UNDERSCORE, "_") : text;
}

/** Same fence rule the chat renderer uses. A fence left open hides the rest. */
const FENCE = /^```([\w-]*)\s*$/u;

function* linesOutsideFences(text: string): Generator<string> {
  let fenced = false;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) yield line;
  }
}

/**
 * Every file path an assistant message shows as a link or a path-like code
 * span. The server grants a read only for a member of this set, matched
 * against a path the client asks for.
 */
export function messageFileLinkPaths(text: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const line of linesOutsideFences(text)) {
    try {
      collectFilePaths(shieldIntrawordUnderscores(line), 0, paths);
    } catch {
      // A malformed escape in one link must not fail the whole grant check.
    }
  }
  return paths;
}

function collectFilePaths(source: string, depth: number, paths: Set<string>): void {
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const token = match[0];
    const link = LINK.exec(token);
    if (link !== null) {
      const target = linkTarget(unshieldUnderscores(link[2] ?? ""));
      if (target.kind === "file") paths.add(target.path);
      continue;
    }
    if (token.startsWith("**") || token.startsWith("__")) {
      if (depth < MAX_INLINE_DEPTH) collectFilePaths(token.slice(2, -2), depth + 1, paths);
      continue;
    }
    if (token.startsWith("`")) {
      const code = unshieldUnderscores(token.slice(1, -1));
      if (pathLike(code)) paths.add(code.trim());
      continue;
    }
    if (depth < MAX_INLINE_DEPTH) collectFilePaths(token.slice(1, -1), depth + 1, paths);
  }
}
