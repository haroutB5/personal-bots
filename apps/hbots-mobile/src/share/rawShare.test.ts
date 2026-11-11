import { describe, expect, it } from "vite-plus/test";

import { parseRawShare } from "./rawShare";

describe("parseRawShare", () => {
  it("reads text and streams", () => {
    const json = JSON.stringify({
      ask: false,
      count: 2,
      items: [
        { kind: "text", text: "hi" },
        { kind: "stream", uri: "file:///c/a.jpg", name: "a.jpg", mime: "image/jpeg", bytes: 10 },
      ],
    });
    expect(parseRawShare(json)).toEqual({
      ask: false,
      count: 2,
      items: [
        { kind: "text", text: "hi" },
        { kind: "stream", uri: "file:///c/a.jpg", name: "a.jpg", mime: "image/jpeg", bytes: 10 },
      ],
    });
  });

  it("keeps a stream the activity did not copy", () => {
    const json = JSON.stringify({
      ask: true,
      count: 1,
      items: [{ kind: "stream", uri: null, name: "b", mime: "application/pdf", bytes: 99 }],
    });
    expect(parseRawShare(json)?.items[0]).toMatchObject({ uri: null });
  });

  it("falls back to the item count", () => {
    expect(parseRawShare(JSON.stringify({ items: [{ kind: "text", text: "x" }] }))).toEqual({
      ask: false,
      count: 1,
      items: [{ kind: "text", text: "x" }],
    });
  });

  it("refuses anything malformed", () => {
    expect(parseRawShare("not json")).toBeNull();
    expect(parseRawShare("[]")).toBeNull();
    expect(parseRawShare(JSON.stringify({ items: [{ kind: "other" }] }))).toBeNull();
    expect(parseRawShare(JSON.stringify({ items: [{ kind: "stream", name: "a" }] }))).toBeNull();
  });
});
