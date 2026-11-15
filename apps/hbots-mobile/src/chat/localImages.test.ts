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
    expect(
      imageLayers({ local: first.previewUri, remoteUrl: null, remoteDrawn: false }),
    ).toEqual({ local: photo.uri, remote: null });
  });

  it("keeps the local file under the server's copy until that copy has drawn", () => {
    const images = createLocalImages();
    images.hold("message-1", [{ attachmentId: "att-1", uri: photo.uri }]);
    const remoteUrl = "https://hbots.example/attachments/att-1?sig=x";

    const local = images.uriFor("att-1");
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
      { attachmentId: "att-1", uri: "file:///a.jpg" },
      { attachmentId: "att-2", uri: "file:///b.jpg" },
    ]);

    images.drawn("att-1");
    expect(images.uriFor("att-1")).toBeNull();
    expect(images.uriFor("att-2")).toBe("file:///b.jpg");

    images.landed("message-1", release);
    expect(release).not.toHaveBeenCalled();

    images.drawn("att-2");
    images.drawn("att-2");
    expect(release).toHaveBeenCalledTimes(1);
    expect(images.uriFor("att-2")).toBeNull();
  });

  it("lets the files go at once when every image already drew before the message landed", () => {
    const images = createLocalImages();
    const release = vi.fn();
    images.hold("message-1", [{ attachmentId: "att-1", uri: "file:///a.jpg" }]);
    images.drawn("att-1");

    images.landed("message-1", release);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("lets the files go at once for a message with no images", () => {
    const images = createLocalImages();
    const release = vi.fn();

    images.landed("message-1", release);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("replaces a failed upload's ids with the retry's ids", () => {
    const images = createLocalImages();
    images.hold("message-1", [{ attachmentId: "att-old", uri: photo.uri }]);
    images.hold("message-1", [{ attachmentId: "att-new", uri: photo.uri }]);

    expect(images.uriFor("att-old")).toBeNull();
    expect(images.uriFor("att-new")).toBe(photo.uri);
  });

  it("forgets a dropped message, so a refused send's files stay with the draft", () => {
    const images = createLocalImages();
    images.hold("message-1", [{ attachmentId: "att-1", uri: photo.uri }]);

    images.drop("message-1");

    expect(images.uriFor("att-1")).toBeNull();
  });
});
