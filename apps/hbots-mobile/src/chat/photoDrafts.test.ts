import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftAttachment } from "./outboxNative";
import { shrinkDrafts, type ShrinkPhoto } from "./photoDrafts";

const cache = "file:///data/user/0/com.haroutb5.hbots/cache";

const cameraPhoto: DraftAttachment = {
  id: "camera",
  kind: "image",
  name: "Camera photo.heic",
  mimeType: "image/heic",
  sizeBytes: 6_000_000,
  uri: `${cache}/ImagePicker/a1.heic`,
};

const screenshot: DraftAttachment = {
  id: "shot",
  kind: "image",
  name: "Screenshot_20261115.png",
  mimeType: "image/png",
  sizeBytes: 458_000,
  uri: `${cache}/share-intake/i1/0-Screenshot_20261115.png`,
};

const pdf: DraftAttachment = {
  id: "pdf",
  kind: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 30_000,
  uri: `${cache}/DocumentPicker/notes.pdf`,
};

describe("every photo a draft takes in is shrunk", () => {
  it("swaps a big photo for its shrunk JPEG and leaves a screenshot and a file alone", async () => {
    const shrink = vi.fn<ShrinkPhoto>(async (uri) =>
      uri === cameraPhoto.uri
        ? { uri: `${cache}/ImagePicker/a1-2576.jpg`, width: 1932, height: 2576, bytes: 612_000 }
        : null,
    );

    const drafts = await shrinkDrafts([cameraPhoto, screenshot, pdf], shrink);

    expect(drafts).toEqual([
      {
        id: "camera",
        kind: "image",
        name: "Camera photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 612_000,
        uri: `${cache}/ImagePicker/a1-2576.jpg`,
      },
      screenshot,
      pdf,
    ]);
    expect(shrink.mock.calls).toEqual([
      [cameraPhoto.uri, "image/heic"],
      [screenshot.uri, "image/png"],
    ]);
  });

  it("keeps the original photo when the shrink fails", async () => {
    const drafts = await shrinkDrafts([cameraPhoto], async () => {
      throw new Error("decode failed");
    });

    expect(drafts).toEqual([cameraPhoto]);
  });

  it("keeps a .jpg name as it is", async () => {
    const jpeg = { ...cameraPhoto, name: "IMG_0001.JPG", mimeType: "image/jpeg" };
    const drafts = await shrinkDrafts([jpeg], async () => ({
      uri: `${cache}/ImagePicker/a1-2576.jpg`,
      width: 2576,
      height: 1932,
      bytes: 700_000,
    }));

    expect(drafts[0]?.name).toBe("IMG_0001.JPG");
  });

  it("has one way into the composer draft, and it shrinks first", () => {
    const source = NodeFS.readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
    const appends = [...source.matchAll(/attachments: \[\.\.\.\w+\.attachments, /g)];
    expect(appends).toHaveLength(1);

    const start = source.indexOf("const addDrafts = async");
    const end = source.indexOf("\n  };\n", start);
    const addDrafts = source.slice(start, end);
    expect(addDrafts).toContain("await shrinkDrafts(next, shrinkPhoto)");
    expect(addDrafts).toMatch(/attachments: \[\.\.\.\w+\.attachments, /);

    for (const picker of [
      "launchImageLibraryAsync",
      "launchCameraAsync",
      "getDocumentAsync",
      "keyboardImages(readShare",
    ]) {
      expect(source, picker).toContain(picker);
    }
    expect([...source.matchAll(/await addPicked\(/g)]).toHaveLength(3);
    expect(source).toContain("void addDrafts(result.drafts, intakeId)");
  });
});
