import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import type { DraftAttachment } from "./outboxNative";
import { PHOTO_THUMB, photosToWarm } from "./photoThumb";

const photo: DraftAttachment = {
  id: "draft-photo",
  kind: "image",
  name: "IMG_0001.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 6_000_000,
  uri: "file:///data/user/0/com.haroutb5.hbots/cache/ImagePicker/IMG_0001.jpg",
};

const second: DraftAttachment = {
  ...photo,
  id: "draft-photo-2",
  uri: "file:///data/user/0/com.haroutb5.hbots/cache/ImagePicker/IMG_0002.jpg",
};

const pdf: DraftAttachment = {
  id: "draft-pdf",
  kind: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1_000,
  uri: "file:///data/user/0/com.haroutb5.hbots/cache/DocumentPicker/notes.pdf",
};

describe("photosToWarm", () => {
  it("warms every image in the draft at the sent bubble's size", () => {
    expect(photosToWarm([photo, pdf, second])).toEqual([
      { id: photo.id, uri: photo.uri },
      { id: second.id, uri: second.uri },
    ]);
    expect(PHOTO_THUMB).toEqual({ width: 200, height: 160 });
  });

  it("has nothing to warm for a file-only draft", () => {
    expect(photosToWarm([pdf])).toEqual([]);
  });

  it("warms the photo before Send, at the same size the bubble draws", () => {
    const image = NodeFS.readFileSync(new URL("./AttachmentImage.tsx", import.meta.url), "utf8");
    const composer = NodeFS.readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");

    expect(composer).toContain("photosToWarm(attachments)");
    expect(composer).toContain("<PrewarmAttachmentImages");
    expect(image).toContain("PHOTO_THUMB.width");
    expect(image).toContain("PHOTO_THUMB.height");
    expect(image).toContain("fadeDuration={0}");
    expect(image).toMatch(/export function PrewarmAttachmentImages/);
  });
});
