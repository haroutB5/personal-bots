/** Wait this long after the last keystroke before searching inside messages. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 300;

const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 100;

/** The query is long enough to search messages for, and short enough for the server. */
export function canSearchMessages(query: string): boolean {
  const length = query.trim().length;
  return length >= MIN_QUERY_CHARS && length <= MAX_QUERY_CHARS;
}

/**
 * Lower-cased one character at a time, keeping a character as it is when its
 * lower case has another length (a few letters grow), so an index in the result
 * is an index in the input.
 */
function foldCase(text: string): string {
  let folded = "";
  for (const character of text) {
    const lower = character.toLocaleLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

export interface SnippetSegment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * The snippet cut into runs, every case-insensitive occurrence of the trimmed
 * query marked as a match. The query is plain text, never a pattern.
 */
export function splitSnippet(snippet: string, query: string): Array<SnippetSegment> {
  if (snippet.length === 0) return [];
  const needle = foldCase(query.trim());
  if (needle.length === 0) return [{ text: snippet, match: false }];
  const haystack = foldCase(snippet);
  const segments: Array<SnippetSegment> = [];
  let cursor = 0;
  for (;;) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    if (found > cursor) segments.push({ text: snippet.slice(cursor, found), match: false });
    segments.push({ text: snippet.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), match: false });
  return segments;
}
