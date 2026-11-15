import { describe, expect, it, vi } from "vite-plus/test";

import { beginSend, pendingSend } from "./composerSendModel";
import { createLocalImages, imageLayers } from "./localImages";
import type { DraftAttachment } from "./outboxNative";

const photo: DraftAttachment = {
  id: "draft-photo",
  kind: "image",
  name: "IMG_0001.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 6_000_000,
  uri: "file:///data/user/0/com.haroutb5.hbots/cache/ImagePicker/IMG_0001.jpg",
};

const pdf: DraftAttachment = {
  id: "draft-pdf",
  kind: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1_000,
  uri: "file:///data/user/0/com.haroutb5.hbots/cache/DocumentPicker/notes.pdf",
};

describe("own image from the tap until the server's copy draws", () => {
  it("draws the local file in the pending bubble before the send resolves", () => {
    const { outgoing } = beginSend(
      { text: "", attachments: [photo, pdf] },
      "message-1",
      "2026-11-15T01:00:00.000Z",
    );
    const bubble = pendingSend(outgoing, "thread-1", "");

    expect(bubble.state).toBe("sending");
    expect(bubble.attachments).toEqual([
      { id: "draft-photo", name: "IMG_0001.jpg", previewUri: photo.uri },
      { id: "draft-pdf", name: "notes.pdf", previewUri: null },
    ]);
    const first = bubble.attachments[0]!;
    expect(imageLayers({ local: first.previewUri, remoteUrl: null, remoteDrawn: false })).toEqual({
      local: photo.uri,
      remote: null,
    });
  });

  it("draws the photo when the server gives the claimed attachment a new id", () => {
    const images = createLocalImages();
    // The upload is held under the id the phone uploaded; the server claims it under a new id.
    images.hold("message-1", [{ index: 0, uri: photo.uri }]);

    // The sent bubble asks by the message and the attachment's place in it, which survive the rewrite.
    const local = images.uriFor("message-1", 0);
    expect(local).toBe(photo.uri);
    expect(imageLayers({ local, remoteUrl: null, remoteDrawn: false })).toEqual({
      local: photo.uri,
      remote: null,
    });
  });

  it("keeps the local file under the server's copy until that copy has drawn", () => {
    const images = createLocalImages();
    images.hold("message-1", [{ index: 0, uri: photo.uri }]);
    const remoteUrl = "https://hbots.example/attachments/att-1?sig=x";

    const local = images.uriFor("message-1", 0);
    expect(local).toBe(photo.uri);
    expect(imageLayers({ local, remoteUrl: null, remoteDrawn: false })).toEqual({
      local: photo.uri,
      remote: null,
    });
    expect(imageLayers({ local, remoteUrl, remoteDrawn: false })).toEqual({
      local: photo.uri,
      remote: remoteUrl,
    });
    expect(imageLayers({ local, remoteUrl, remoteDrawn: true })).toEqual({
      local: null,
      remote: remoteUrl,
    });
  });

  it("shows today's placeholder when no local file is known", () => {
    expect(imageLayers({ local: null, remoteUrl: null, remoteDrawn: false })).toEqual({
      local: null,
      remote: null,
    });
  });

  it("lets the message's files go only after it landed and every image drew", () => {
    const images = createLocalImages();
    const release = vi.fn();
    images.hold("message-1", [
      { index: 0, uri: "file:///a.jpg" },
      { index: 1, uri: "file:///b.jpg" },
    ]);

    images.drawn("message-1", 0);
    expect(images.uriFor("message-1", 0)).toBeNull();
    expect(images.uriFor("message-1", 1)).toBe("file:///b.jpg");

    images.landed("message-1", release);
    expect(release).not.toHaveBeenCalled();

    images.drawn("message-1", 1);
    images.drawn("message-1", 1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(images.uriFor("message-1", 1)).toBeNull();
  });

  it("lets the files go at once when every image already drew before the message landed", () => {
    const images = createLocalImages();
    const release = vi.fn();
    images.hold("message-1", [{ index: 0, uri: "file:///a.jpg" }]);
    images.drawn("message-1", 0);

    images.landed("message-1", release);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("lets the files go at once for a message with no images", () => {
    const images = createLocalImages();
    const release = vi.fn();

    images.landed("message-1", release);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("replaces a failed upload's file with the retry's file", () => {
    const images = createLocalImages();
    images.hold("message-1", [{ index: 0, uri: "file:///old.jpg" }]);
    images.hold("message-1", [{ index: 0, uri: photo.uri }]);

    expect(images.uriFor("message-1", 0)).toBe(photo.uri);
  });

  it("forgets a dropped message, so a refused send's files stay with the draft", () => {
    const images = createLocalImages();
    images.hold("message-1", [{ index: 0, uri: photo.uri }]);

    images.drop("message-1");

    expect(images.uriFor("message-1", 0)).toBeNull();
  });
});
