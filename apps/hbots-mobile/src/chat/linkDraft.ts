/**
 * A notification reply too long to send from the shade opens the chat with the text as a draft:
 * `hbots://chat/<bot>/<thread>?draft=...`. The composer already reads its starting text from the draft
 * store, so the link only has to put the text there before the chat opens.
 */

/** The composer's draft key. The composer and a link draft must agree, so there is one definition. */
export function draftKey(environmentId: string, threadId: string): string {
  return `t3code:composer-draft:v1:${environmentId}:${threadId}`;
}

/** Same ceiling as the native side. A longer draft is refused rather than cut. */
export const MAX_LINK_DRAFT = 16_000;

export function cleanLinkDraft(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw.trim().length === 0 || raw.length > MAX_LINK_DRAFT) return undefined;
  return raw;
}

/** Text already in the composer is kept; the link's text goes after it. */
export function mergeDraft(existing: string | null | undefined, incoming: string): string {
  if (existing === null || existing === undefined || existing.trim().length === 0) return incoming;
  if (existing.endsWith(incoming)) return existing;
  return `${existing}\n\n${incoming}`;
}

export interface DraftStore {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function storeLinkDraft(
  store: DraftStore,
  environmentId: string,
  threadId: string,
  draft: string,
): void {
  const key = draftKey(environmentId, threadId);
  store.setItem(key, mergeDraft(store.getItem(key), draft));
}
