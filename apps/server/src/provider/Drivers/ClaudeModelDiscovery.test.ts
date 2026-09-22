import { assert, describe, it } from "@effect/vitest";

import { scanClaudeModelSlugChunks } from "./ClaudeModelDiscovery.ts";

describe("Claude model binary discovery", () => {
  it("finds a bare model slug split across chunks", () => {
    const slugs = scanClaudeModelSlugChunks(["prefix claude-op", "us-5-5 suffix claude-sonnet-5"]);
    assert.deepStrictEqual([...slugs].toSorted(), ["claude-opus-5-5", "claude-sonnet-5"]);
  });

  it("ignores dated, suffixed, and embedded model strings", () => {
    const slugs = scanClaudeModelSlugChunks([
      "claude-haiku-4-5-20251001 ",
      "claude-opus-4-20250514-v1 xclaude-sonnet-5",
    ]);
    assert.deepStrictEqual([...slugs], []);
  });
});
