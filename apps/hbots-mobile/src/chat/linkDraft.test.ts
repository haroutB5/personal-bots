import { describe, expect, it } from "vite-plus/test";

import { cleanLinkDraft, draftKey, MAX_LINK_DRAFT, mergeDraft, storeLinkDraft } from "./linkDraft";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("a draft that arrives on a link", () => {
  it("lands under the composer's own key", () => {
    const store = memory();
    storeLinkDraft(store, "env", "t1", "long text");
    expect(store.map.get(draftKey("env", "t1"))).toBe("long text");
    expect(draftKey("env", "t1")).toBe("t3code:composer-draft:v1:env:t1");
  });

  it("keeps what was already typed", () => {
    const store = memory();
    store.setItem(draftKey("env", "t1"), "half a thought");
    storeLinkDraft(store, "env", "t1", "the reply");
    expect(store.map.get(draftKey("env", "t1"))).toBe("half a thought\n\nthe reply");
  });

  it("does not repeat itself when the same link opens twice", () => {
    expect(mergeDraft("the reply", "the reply")).toBe("the reply");
  });

  it("refuses empty and oversized text instead of cutting it", () => {
    expect(cleanLinkDraft(undefined)).toBeUndefined();
    expect(cleanLinkDraft("   ")).toBeUndefined();
    expect(cleanLinkDraft("a".repeat(MAX_LINK_DRAFT + 1))).toBeUndefined();
    expect(cleanLinkDraft("a".repeat(MAX_LINK_DRAFT))).toHaveLength(MAX_LINK_DRAFT);
  });
});
