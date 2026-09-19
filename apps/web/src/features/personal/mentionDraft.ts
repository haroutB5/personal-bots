/**
 * The `@mention` autocomplete, as pure text arithmetic.
 *
 * Nothing here touches the DOM or React: the composer hands in the draft text
 * and the caret offset and gets back the token being typed and the exact range
 * to replace. That is what makes multi-word bot names, mid-sentence edits and
 * the "did the caret leave the token" case testable without a browser.
 */

export interface MentionDraft {
  /** What has been typed after the `@`, without the `@` itself. */
  readonly query: string;
  /** Offset of the `@`. */
  readonly start: number;
  /** Offset just past the last character of the token (usually the caret). */
  readonly end: number;
}

/**
 * Longest query an open mention token may have. Bot names are short; past this
 * the owner is writing a sentence that happens to contain an `@`, not naming a
 * bot, and the popover should be out of the way.
 */
const MAX_QUERY_CHARS = 40;

/** Rows the popover shows at once — the member cap, so a group always fits. */
export const MENTION_SUGGESTION_LIMIT = 6;

/**
 * The mention being typed at `caret`, or null when there is none.
 *
 * The `@` must open a word (start of the draft, or preceded by whitespace), so
 * an email address never opens the popover, and the token ends at the caret so
 * moving the caret away from a finished mention closes it.
 */
export function activeMentionDraft(text: string, caret: number): MentionDraft | null {
  const at = Math.max(0, Math.min(caret, text.length));
  // `lastIndexOf` clamps a negative `fromIndex` to 0, so a caret at the very
  // start would otherwise "find" an `@` sitting ahead of it.
  if (at === 0) return null;
  const start = text.lastIndexOf("@", at - 1);
  if (start === -1 || start >= at) return null;
  const before = start === 0 ? "" : text.charAt(start - 1);
  if (before !== "" && !/\s/.test(before)) return null;
  const query = text.slice(start + 1, at);
  // A newline ends the token, and "@ " is punctuation ("meet @ 5"), not a name.
  if (/[\n\r]/.test(query)) return null;
  if (query.startsWith(" ") || query.length > MAX_QUERY_CHARS) return null;
  return { query, start, end: at };
}

export interface MentionCandidate {
  readonly botId: string;
  readonly name: string;
}

/**
 * Members whose name matches the token, best first: names that start with the
 * query before names that merely contain it, then alphabetically. An empty
 * query (the moment `@` is typed) lists everyone, in the order given.
 */
export function matchMentionCandidates<T extends MentionCandidate>(
  candidates: ReadonlyArray<T>,
  query: string,
  limit: number = MENTION_SUGGESTION_LIMIT,
): ReadonlyArray<T> {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return candidates.slice(0, limit);
  const scored = candidates.flatMap((candidate) => {
    const name = candidate.name.toLocaleLowerCase();
    if (name.startsWith(needle)) return [{ candidate, rank: 0 }];
    if (name.includes(needle)) return [{ candidate, rank: 1 }];
    return [];
  });
  return scored
    .toSorted(
      (left, right) =>
        left.rank - right.rank || left.candidate.name.localeCompare(right.candidate.name),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export interface MentionInsertion {
  readonly text: string;
  /** Where the caret belongs afterwards: just past the trailing space. */
  readonly caret: number;
}

/**
 * Replaces the token with `@Name `. The trailing space is deliberate: it both
 * closes the token (so the popover shuts) and is what the owner would type
 * next anyway.
 */
export function applyMention(text: string, draft: MentionDraft, name: string): MentionInsertion {
  const inserted = `@${name} `;
  // Never double the space when the caret already sits in front of one.
  const tail = text.slice(draft.end);
  const trimmedTail = tail.startsWith(" ") ? tail.slice(1) : tail;
  return {
    text: `${text.slice(0, draft.start)}${inserted}${trimmedTail}`,
    caret: draft.start + inserted.length,
  };
}
