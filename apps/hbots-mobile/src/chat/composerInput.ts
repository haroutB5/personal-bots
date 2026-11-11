import { blockedMessage, intakeShare, type RawShare } from "../share/pickerModel";
import type { DraftAttachment } from "./outboxNative";

/**
 * An image from the keyboard (Gboard stickers, GIFs, pasted images) goes through the same
 * intake as a shared image: the same count and size caps, the same type check, the same
 * refusal text. Pure, so the rule is tested without the native module.
 */
export type KeyboardImages =
  | { readonly ok: true; readonly drafts: ReadonlyArray<DraftAttachment> }
  | { readonly ok: false; readonly message: string };

export function keyboardImages(
  raw: RawShare | null,
  makeId: (index: number) => string,
): KeyboardImages {
  if (raw === null) return { ok: false, message: blockedMessage("empty") };
  const intake = intakeShare(raw);
  if (!intake.ok) return { ok: false, message: blockedMessage(intake.reason) };
  if (intake.intent.kind !== "share") return { ok: false, message: blockedMessage("empty") };
  const drafts: DraftAttachment[] = [];
  for (const item of intake.intent.items) {
    if (item.kind === "text") continue;
    drafts.push({
      id: makeId(drafts.length),
      kind: item.kind,
      name: item.name,
      mimeType: item.mime,
      sizeBytes: item.bytes,
      uri: item.uri,
    });
  }
  if (drafts.length === 0) return { ok: false, message: blockedMessage("empty") };
  return { ok: true, drafts };
}

/**
 * Which intake folders to delete: those whose attachments are no longer in the draft. The
 * folder is the only copy of the image outside the outbox, so it goes as soon as the draft
 * lets go of it.
 */
export function releasedIntakes(
  held: ReadonlyMap<string, string>,
  attachments: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<string> {
  const present = new Set(attachments.map((attachment) => attachment.id));
  const stillHeld = new Set<string>();
  for (const [attachmentId, intakeId] of held) {
    if (present.has(attachmentId)) stillHeld.add(intakeId);
  }
  const gone = new Set<string>();
  for (const intakeId of held.values()) {
    if (!stillHeld.has(intakeId)) gone.add(intakeId);
  }
  return [...gone];
}
