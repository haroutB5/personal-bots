import { describe, expect, it } from "vite-plus/test";
import {
  SHARE_MAX_BYTES,
  SHARE_MAX_ITEMS,
  blockedMessage,
  type RawShare,
  type RawShareItem,
} from "../share/pickerModel";
import { keyboardImages, releasedIntakes } from "./composerInput";

const makeId = (index: number) => `draft-${index}`;

function image(overrides: Partial<Extract<RawShareItem, { kind: "stream" }>> = {}): RawShareItem {
  return {
    kind: "stream",
    uri: "file:///cache/share-intake/abc/0-sticker.png",
    name: "sticker.png",
    mime: "image/png",
    bytes: 4096,
    ...overrides,
  };
}

function raw(items: ReadonlyArray<RawShareItem>, count = items.length): RawShare {
  return { ask: false, count, items };
}

describe("an image from the keyboard", () => {
  it("becomes a draft attachment like a shared image", () => {
    const result = keyboardImages(raw([image()]), makeId);
    expect(result).toEqual({
      ok: true,
      drafts: [
        {
          id: "draft-0",
          kind: "image",
          name: "sticker.png",
          mimeType: "image/png",
          sizeBytes: 4096,
          uri: "file:///cache/share-intake/abc/0-sticker.png",
        },
      ],
    });
  });

  it("is refused over 25 MB with the shared message", () => {
    const result = keyboardImages(raw([image({ bytes: SHARE_MAX_BYTES + 1 })]), makeId);
    expect(result).toEqual({ ok: false, message: blockedMessage("too-large") });
  });

  it("is refused when the copy was over the cap and left no file", () => {
    const result = keyboardImages(raw([image({ uri: null })]), makeId);
    expect(result).toEqual({ ok: false, message: blockedMessage("too-large") });
  });

  it("is refused past ten items with the shared message", () => {
    const many = Array.from({ length: SHARE_MAX_ITEMS + 1 }, () => image());
    const result = keyboardImages(raw(many), makeId);
    expect(result).toEqual({ ok: false, message: blockedMessage("too-many-items") });
  });

  it("is refused for a type hbots does not take, with the shared message", () => {
    const result = keyboardImages(raw([image({ mime: "video/mp4", name: "clip.mp4" })]), makeId);
    expect(result).toEqual({ ok: false, message: blockedMessage("unsupported-type") });
  });

  it("is refused when the keyboard sent nothing", () => {
    expect(keyboardImages(null, makeId)).toEqual({ ok: false, message: blockedMessage("empty") });
    expect(keyboardImages(raw([]), makeId)).toEqual({
      ok: false,
      message: blockedMessage("empty"),
    });
  });

  it("gives each draft its own id", () => {
    const result = keyboardImages(raw([image(), image({ name: "b.png" })]), makeId);
    expect(result.ok && result.drafts.map((draft) => draft.id)).toEqual(["draft-0", "draft-1"]);
  });
});

describe("the intake folders the draft let go of", () => {
  const held = new Map([
    ["a", "intake-1"],
    ["b", "intake-1"],
    ["c", "intake-2"],
  ]);

  it("keeps a folder while any of its images is still in the draft", () => {
    expect(releasedIntakes(held, [{ id: "b" }, { id: "c" }])).toEqual([]);
  });

  it("releases a folder once all of its images are gone", () => {
    expect(releasedIntakes(held, [{ id: "c" }])).toEqual(["intake-1"]);
  });

  it("releases everything when the draft is empty", () => {
    expect([...releasedIntakes(held, [])].sort()).toEqual(["intake-1", "intake-2"]);
  });

  it("releases nothing when nothing was held", () => {
    expect(releasedIntakes(new Map(), [{ id: "a" }])).toEqual([]);
  });
});
