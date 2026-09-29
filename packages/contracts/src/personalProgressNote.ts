/**
 * The "latest progress" line of a working bot: one short, muted line under the
 * Working indicator of a chat and on the Bots list row, so a chat whose model
 * keeps its progress in thinking summaries (Sonnet) does not look blank.
 *
 * Shared by the client (which already holds the open chat's messages and
 * activities) and the server (which answers for the Bots list). Only two
 * sources are ever read: a reasoning / thinking message, and the TITLE of a
 * tool step. Tool output, tool arguments and step detail never feed it, and a
 * secret-looking run is blanked before the line is cut, so what is shown
 * cannot leak what a step handled.
 */

export const PERSONAL_PROGRESS_NOTE_MAX_CHARS = 120;

const HIDDEN = "[hidden]";

/** Runs that look like a credential. Blanked before the line is trimmed. */
const SECRET_LIKE: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bPB_SECRET_[A-Z0-9_]+\s*[=:]\s*\S+/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\b\s*[=:]\s*\S+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  // A long unbroken run of key characters: a hash, a token, base64.
  /[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

/** A summary block's title: bold, on a line of its own or right after the previous block. */
const SUMMARY_TITLE = /(?:^|\n|(?<=[.!?:)]))\*\*([^*\n]{2,150})\*\*(?=\n|$)/g;

/** A code fence or a rule is not a sentence. */
const FENCE_OR_RULE = /^(`{3,}|~{3,}|[-*_]{3,}\s*$)/;

/** The words of one line, without the markdown around them. */
function plainLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}(\s+|$)/, "")
    .replace(/^>\s?/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function redact(line: string): string {
  let out = line;
  for (const pattern of SECRET_LIKE) out = out.replace(pattern, HIDDEN);
  return out;
}

function clip(line: string, max: number): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** One line as a note: plain, redacted, clipped; null when nothing readable is left. */
function noteFromLine(raw: string, max: number): string | null {
  if (FENCE_OR_RULE.test(raw.trim())) return null;
  const line = redact(plainLine(raw));
  return line.length > 0 && line !== HIDDEN ? clip(line, max) : null;
}

/**
 * A thinking message accumulates for the whole turn (its blocks run on, the
 * next block's title often straight after the last block's full stop), so its
 * NEWEST words are at the end. A summary block opens with its title in bold,
 * "**Reading the failing test**": the last such title is the latest progress.
 * Raw thinking has no titles; its last non-empty line stands in.
 */
export function progressNoteFromReasoning(
  text: string,
  max: number = PERSONAL_PROGRESS_NOTE_MAX_CHARS,
): string | null {
  const titles = [...text.matchAll(SUMMARY_TITLE)];
  for (let index = titles.length - 1; index >= 0; index -= 1) {
    const note = noteFromLine(titles[index]![1]!, max);
    if (note !== null) return note;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const note = noteFromLine(lines[index]!, max);
    if (note !== null) return note;
  }
  return null;
}

/** The note for a tool step: its title only ("Running tests"), plain and clipped. */
export function progressNoteFromToolTitle(
  title: string,
  max: number = PERSONAL_PROGRESS_NOTE_MAX_CHARS,
): string | null {
  for (const raw of title.split("\n")) {
    const note = noteFromLine(raw, max);
    if (note !== null) return note;
  }
  return null;
}

/**
 * The text of a tool step's note: its payload `title`, else its activity
 * summary without the "started" / "updated" / "completed" the runtime appends
 * ("Running tests started" reads as "Running tests"). Null when neither has
 * anything.
 */
export function toolStepNoteText(
  title: unknown,
  summary: string | null | undefined,
): string | null {
  if (typeof title === "string" && title.trim().length > 0) return title;
  const plain = (summary ?? "").replace(/\s+(started|updated|completed)$/i, "").trim();
  return plain.length > 0 ? plain : null;
}

export interface ProgressNoteSource {
  /** Raw text (reasoning) or title (tool step). */
  readonly text: string;
  /** ISO time it was last written, for picking the newest source. */
  readonly at: string;
}

/**
 * The newest of the latest reasoning message and the latest tool step title,
 * or null when neither yields a line. A reasoning message wins a tie or a
 * missing time: it is the richer sentence.
 */
export function pickProgressNote(input: {
  readonly reasoning?: ProgressNoteSource | null | undefined;
  readonly tool?: ProgressNoteSource | null | undefined;
  readonly max?: number;
}): string | null {
  const max = input.max ?? PERSONAL_PROGRESS_NOTE_MAX_CHARS;
  const reasoning =
    input.reasoning == null ? null : progressNoteFromReasoning(input.reasoning.text, max);
  const tool = input.tool == null ? null : progressNoteFromToolTitle(input.tool.text, max);
  if (reasoning === null) return tool;
  if (tool === null) return reasoning;
  const reasoningAt = Date.parse(input.reasoning?.at ?? "");
  const toolAt = Date.parse(input.tool?.at ?? "");
  if (Number.isFinite(reasoningAt) && Number.isFinite(toolAt) && toolAt > reasoningAt) return tool;
  return reasoning;
}
