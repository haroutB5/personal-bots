/**
 * The device files behind this phone's sent images, keyed by message and image place: the server
 * claims an upload under a new id, so the upload id cannot key the file, while the message id and
 * order survive. Each file is let go once the message landed and its server copy drew.
 */
interface HeldImage {
  readonly index: number;
  readonly uri: string;
}

export interface LocalImages {
  /** After the upload: these files are the message's images, in the order the server echoes. */
  readonly hold: (messageId: string, images: ReadonlyArray<HeldImage>) => void;
  readonly uriFor: (messageId: string, index: number) => string | null;
  /** The server's copy has drawn; the file is no longer needed for this image. */
  readonly drawn: (messageId: string, index: number) => void;
  /** The message landed. `release` runs now, or when its last held image draws. */
  readonly landed: (messageId: string, release: () => void) => void;
  /** The message will not show from the server (refused, queued, restored into the draft). */
  readonly drop: (messageId: string) => void;
}

export function createLocalImages(): LocalImages {
  const held = new Map<string, Map<number, string>>();
  const releases = new Map<string, () => void>();

  const settle = (messageId: string) => {
    if ((held.get(messageId)?.size ?? 0) > 0) return;
    held.delete(messageId);
    const release = releases.get(messageId);
    releases.delete(messageId);
    release?.();
  };

  const drop = (messageId: string) => {
    held.delete(messageId);
    releases.delete(messageId);
  };

  return {
    hold: (messageId, images) => {
      drop(messageId);
      held.set(messageId, new Map(images.map((image) => [image.index, image.uri])));
    },
    uriFor: (messageId, index) => held.get(messageId)?.get(index) ?? null,
    drawn: (messageId, index) => {
      const slots = held.get(messageId);
      if (slots === undefined || !slots.delete(index)) return;
      if (releases.has(messageId)) settle(messageId);
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
