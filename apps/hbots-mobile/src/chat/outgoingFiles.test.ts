import { setOutboxBlobBackendForTesting } from "@hbots/personal-client/composer/outboxBlobs";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { DraftAttachment } from "./outboxNative";
import { discardOutgoingFiles, readableOutgoingFiles, retainOutgoingFiles } from "./outgoingFiles";

const sourceUri = "file:///cache/share-intake/share-1/0-photo.jpg";

const photo: DraftAttachment = {
  id: "photo-1",
  kind: "image",
  name: "photo.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  uri: sourceUri,
};

function memoryBackend() {
  const files = new Map<string, string>([[sourceUri, "jpeg bytes"]]);
  return {
    files,
    backend: {
      put: async (key: string, blob: { readonly uri: string }) => {
        const bytes = files.get(blob.uri);
        if (bytes === undefined) throw new Error("The source file is gone.");
        files.set(`blob/${key}`, bytes);
      },
      get: async (key: string) => {
        const bytes = files.get(`blob/${key}`);
        if (bytes === undefined) return null;
        return {
          uri: `file:///cache/open/${key}`,
          size: bytes.length,
          mimeType: "image/jpeg",
          name: "photo.jpg",
        };
      },
      deletePrefix: async (prefix: string) => {
        for (const key of files.keys()) {
          if (key.startsWith(`blob/${prefix}`)) files.delete(key);
        }
      },
      keys: async () =>
        [...files.keys()]
          .filter((key) => key.startsWith("blob/"))
          .map((key) => key.slice("blob/".length)),
    },
  };
}

afterEach(() => {
  setOutboxBlobBackendForTesting();
});

describe("a send's attachment files", () => {
  it("stay readable after the draft deletes the intake folder", async () => {
    const { files, backend } = memoryBackend();
    setOutboxBlobBackendForTesting(backend);

    expect(await retainOutgoingFiles("message-1", [photo])).toBe(true);
    files.delete(sourceUri);

    expect(await readableOutgoingFiles("message-1", [photo])).toEqual([
      { ...photo, uri: "file:///cache/open/message-1/photo-1" },
    ]);
  });

  it("are deleted once the send succeeds", async () => {
    const { backend } = memoryBackend();
    setOutboxBlobBackendForTesting(backend);

    expect(await retainOutgoingFiles("message-1", [photo])).toBe(true);
    expect(await readableOutgoingFiles("message-1", [photo])).not.toBeNull();

    await discardOutgoingFiles("message-1");

    expect(await readableOutgoingFiles("message-1", [photo])).toBeNull();
  });
});
