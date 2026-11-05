/** The text a send with attachments and no words carries to the model. */
export const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";

/** What the owner's own bubble shows: the placeholder sent for an attachment-only message is not their text. */
export function ownerVisibleText(text: string): string {
  const trimmed = text.trim();
  return trimmed === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT || trimmed.length === 0 ? "" : text;
}
