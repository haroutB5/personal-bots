import type { DraftAttachment } from "./outboxNative";

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}

export interface Outgoing extends ComposerDraft {
  readonly id: string;
  readonly state: "sending" | "failed";
}

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };

export function hasDraftContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

/** Takes the draft into the outgoing message, leaving an empty composer behind. */
export function beginSend(
  draft: ComposerDraft,
  id: string,
): { readonly draft: ComposerDraft; readonly outgoing: Outgoing } {
  return {
    draft: EMPTY_DRAFT,
    outgoing: { text: draft.text, attachments: draft.attachments, id, state: "sending" },
  };
}

/** On failure the failed text goes back in front of anything typed since. */
export function settle(
  outgoing: Outgoing,
  result: { readonly ok: boolean },
  currentDraft: ComposerDraft,
): { readonly draft: ComposerDraft } {
  if (result.ok) return { draft: currentDraft };
  const text =
    outgoing.text.length === 0
      ? currentDraft.text
      : currentDraft.text.trim().length === 0
        ? outgoing.text
        : `${outgoing.text}\n\n${currentDraft.text}`;
  const attachments =
    outgoing.attachments.length === 0
      ? currentDraft.attachments
      : currentDraft.attachments.length === 0
        ? outgoing.attachments
        : [...outgoing.attachments, ...currentDraft.attachments];
  return { draft: { text, attachments } };
}
