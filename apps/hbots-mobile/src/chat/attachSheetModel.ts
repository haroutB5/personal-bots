/**
 * What the plus sheet shows under its Camera row. The embedded system picker shows recent photos
 * at once; a phone without it, or one whose picker session failed, gets an "All photos" row that
 * opens the full system picker as before. With no room left in the draft there is nothing to pick.
 */
export type AttachPhotos =
  | { readonly kind: "embedded"; readonly maxSelection: number }
  | { readonly kind: "all-photos" }
  | { readonly kind: "full"; readonly message: string };

export function attachPhotos(input: {
  readonly embedded: boolean;
  readonly attached: number;
  readonly maxAttachments: number;
}): AttachPhotos {
  const room = input.maxAttachments - input.attached;
  if (room <= 0) {
    return {
      kind: "full",
      message: `This message already has ${input.maxAttachments} attachments. Remove one to add another.`,
    };
  }
  if (!input.embedded) return { kind: "all-photos" };
  return { kind: "embedded", maxSelection: room };
}

export interface ComposerNotice {
  readonly message: string;
  readonly openSettings: boolean;
}

export function plainNotice(message: string): ComposerNotice {
  return { message, openSettings: false };
}

/** A refused camera permission. Once Android stops asking, only Settings can turn it back on. */
export function cameraRefusal(permission: {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}): ComposerNotice | null {
  if (permission.granted) return null;
  return { message: "Camera access is off for hbots.", openSettings: !permission.canAskAgain };
}
