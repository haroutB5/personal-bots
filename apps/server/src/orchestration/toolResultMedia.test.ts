import { describe, expect, it } from "vite-plus/test";

import { base64DecodedBytes, stripToolResultMedia } from "./toolResultMedia.ts";

const PNG = Buffer.alloc(3_001, 7).toString("base64");

describe("stripToolResultMedia", () => {
  it("returns the same reference when there is no media", () => {
    const data = { toolName: "Bash", result: { content: [{ type: "text", text: "ok" }] } };
    expect(stripToolResultMedia(data)).toBe(data);
    expect(stripToolResultMedia("plain")).toBe("plain");
    expect(stripToolResultMedia(null)).toBe(null);
  });

  it("replaces an Anthropic base64 source with media type and decoded size", () => {
    const data = {
      toolName: "mcp__t3-code__preview_snapshot",
      result: {
        content: [
          { type: "text", text: '{"url":"http://localhost:3000"}' },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ],
      },
    };
    const stripped = stripToolResultMedia(data);
    expect(stripped).not.toBe(data);
    expect(stripped.result.content[0]).toBe(data.result.content[0]);
    expect(stripped.result.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", omittedBytes: 3_001 },
    });
    expect(data.result.content[1]!.source!.data).toBe(PNG);
  });

  it("replaces an MCP/ACP image or audio block's data", () => {
    const stripped = stripToolResultMedia([
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "audio", data: PNG, mimeType: "audio/wav" },
    ]);
    expect(stripped).toEqual([
      { type: "image", mimeType: "image/png", omittedBytes: 3_001 },
      { type: "audio", mimeType: "audio/wav", omittedBytes: 3_001 },
    ]);
  });

  it("leaves non-base64 data strings alone", () => {
    const data = { type: "image", data: "https://example.com/a.png" };
    expect(stripToolResultMedia(data)).toBe(data);
    const short = { type: "base64", data: "abc" };
    expect(stripToolResultMedia(short)).toBe(short);
  });

  it("computes the decoded byte size from padding", () => {
    for (const size of [16, 17, 18, 1_000, 4_096]) {
      const encoded = Buffer.alloc(size, 1).toString("base64");
      expect(base64DecodedBytes(encoded)).toBe(size);
    }
  });
});
