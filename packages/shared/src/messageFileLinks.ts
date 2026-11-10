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
    const withoutScheme = decodeURIComponent(trimmed.replace(/^file:\/\//iu, ""));
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
const INLINE_TOKEN =
  /(\*\*(?:\*(?!\*)|[^*])+\*\*|__(?:_(?!_)|[^_])+__|\*(?![\s*])[^*\n]*[^\s*]\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\))/gu;

/** Mirrors the renderer's nesting limit for emphasis. */
const MAX_INLINE_DEPTH = 4;

/**
 * Every file path an assistant message shows as a link or a path-like code
 * span. The server grants a read only for a member of this set, matched
 * against a path the client asks for.
 */
export function messageFileLinkPaths(text: string): ReadonlySet<string> {
  const paths = new Set<string>();
  try {
    collectFilePaths(text, 0, paths);
  } catch {
    // A malformed escape in one link must not fail the whole grant check.
  }
  return paths;
}

function collectFilePaths(source: string, depth: number, paths: Set<string>): void {
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const token = match[0];
    const link = LINK.exec(token);
    if (link !== null) {
      const target = linkTarget(link[2] ?? "");
      if (target.kind === "file") paths.add(target.path);
      continue;
    }
    if (token.startsWith("**") || token.startsWith("__")) {
      if (depth < MAX_INLINE_DEPTH) collectFilePaths(token.slice(2, -2), depth + 1, paths);
      continue;
    }
    if (token.startsWith("`")) {
      const code = token.slice(1, -1);
      if (pathLike(code)) paths.add(code.trim());
      continue;
    }
    if (depth < MAX_INLINE_DEPTH) collectFilePaths(token.slice(1, -1), depth + 1, paths);
  }
}
