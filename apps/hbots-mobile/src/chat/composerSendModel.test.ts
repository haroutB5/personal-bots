import { describe, expect, it } from "vite-plus/test";
import type { DraftAttachment } from "./outboxNative";
import { EMPTY_DRAFT, beginSend, hasDraftContent, settle } from "./composerSendModel";

const photo: DraftAttachment = {
  id: "photo-1",
  kind: "image",
  name: "photo.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  uri: "file:///photo.jpg",
};

describe("beginSend", () => {
  it("empties the draft during a send that never resolves", () => {
    const { draft, outgoing } = beginSend({ text: "Hello", attachments: [photo] }, "message-1");
    expect(draft).toEqual(EMPTY_DRAFT);
    expect(hasDraftContent(draft)).toBe(false);
    expect(outgoing).toEqual({
      id: "message-1",
      text: "Hello",
      attachments: [photo],
      state: "sending",
    });
    expect(hasDraftContent({ text: "Second", attachments: [] })).toBe(true);
  });
});

describe("settle", () => {
  it("puts a rejected text back into an empty field", () => {
    const { outgoing } = beginSend({ text: "Hello", attachments: [photo] }, "message-1");
    const { draft } = settle(outgoing, { ok: false }, EMPTY_DRAFT);
    expect(draft).toEqual({ text: "Hello", attachments: [photo] });
  });

  it("puts the rejected text in front of text typed since", () => {
    const { outgoing } = beginSend({ text: "Hello", attachments: [] }, "message-1");
    const { draft } = settle(outgoing, { ok: false }, { text: "Second", attachments: [] });
    expect(draft).toEqual({ text: "Hello\n\nSecond", attachments: [] });
  });

  it("keeps text typed during the wait when the send succeeds", () => {
    const { outgoing } = beginSend({ text: "Hello", attachments: [] }, "message-1");
    const { draft } = settle(outgoing, { ok: true }, { text: "Second", attachments: [] });
    expect(draft).toEqual({ text: "Second", attachments: [] });
  });
});
