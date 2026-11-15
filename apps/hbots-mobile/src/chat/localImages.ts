/**
 * The device files behind images this phone just sent, by the server's attachment id. The sent
 * bubble draws the file until the server's copy has drawn, so the photo stays on screen from the
 * tap onward. A message's files are let go (its `release`) once the message has landed and each
 * of its images has drawn from the server.
 */
export interface LocalImages {
  /** After the upload: these server attachment ids were sent from these files. */
  readonly hold: (
    messageId: string,
    images: ReadonlyArray<{ readonly attachmentId: string; readonly uri: string }>,
  ) => void;
  readonly uriFor: (attachmentId: string) => string | null;
  /** The server's copy has drawn; the file is no longer needed for this attachment. */
  readonly drawn: (attachmentId: string) => void;
  /** The message landed. `release` runs now, or when its last held image draws. */
  readonly landed: (messageId: string, release: () => void) => void;
  /** The message will not show from the server (refused, queued, restored into the draft). */
  readonly drop: (messageId: string) => void;
}

export function createLocalImages(): LocalImages {
  const uris = new Map<string, string>();
  const byMessage = new Map<string, Set<string>>();
  const releases = new Map<string, () => void>();

  const settle = (messageId: string) => {
    if ((byMessage.get(messageId)?.size ?? 0) > 0) return;
    byMessage.delete(messageId);
    const release = releases.get(messageId);
    releases.delete(messageId);
    release?.();
  };

  const drop = (messageId: string) => {
    for (const attachmentId of byMessage.get(messageId) ?? []) uris.delete(attachmentId);
    byMessage.delete(messageId);
    releases.delete(messageId);
  };

  return {
    hold: (messageId, images) => {
      drop(messageId);
      const held = new Set<string>();
      for (const image of images) {
        uris.set(image.attachmentId, image.uri);
        held.add(image.attachmentId);
      }
      byMessage.set(messageId, held);
    },
    uriFor: (attachmentId) => uris.get(attachmentId) ?? null,
    drawn: (attachmentId) => {
      if (!uris.delete(attachmentId)) return;
      for (const [messageId, held] of byMessage) {
        if (!held.delete(attachmentId)) continue;
        if (releases.has(messageId)) settle(messageId);
        return;
      }
    },
    landed: (messageId, release) => {
      releases.set(messageId, release);
      settle(messageId);
    },
    drop,
  };
}

export const localImages = createLocalImages();

/**
 * What an image bubble draws. The local file shows at once and stays under the server's copy
 * until that copy has drawn, so there is no blank frame between them. With neither, the bubble
 * shows a placeholder.
 */
export interface ImageLayers {
  readonly local: string | null;
  readonly remote: string | null;
}

export function imageLayers(input: {
  readonly local: string | null;
  readonly remoteUrl: string | null;
  readonly remoteDrawn: boolean;
}): ImageLayers {
  return {
    local: input.remoteDrawn ? null : input.local,
    remote: input.remoteUrl,
  };
}
