import { describe, expect, it } from "vite-plus/test";

import {
  catalogInstallFailureNote,
  entryMatchesSearch,
  filterMatches,
  highlightNameMatch,
  normalizeSearch,
  partitionCatalog,
  unsupportedReasonCopy,
} from "./catalogModel";
import type { ProviderCatalogCost, ProviderCatalogEntry } from "./catalogTypes";

function entry(
  partial: Partial<ProviderCatalogEntry> & { catalogId: string; name: string },
): ProviderCatalogEntry {
  return {
    source: "registry",
    publisher: "Test Publisher",
    description: "A coding agent for tests.",
    website: null,
    repository: null,
    license: "MIT",
    openSource: true,
    version: "1.0.0",
    iconUrl: null,
    distribution: { kind: "npm", label: "npm · test-pkg" },
    downloadBytes: 50_000_000,
    sha256Checked: true,
    cost: { kind: "free", label: "Free", detail: null },
    signInLabel: "Google account",
    popularRank: null,
    supported: { ok: true },
    added: null,
    ...partial,
  };
}

describe("catalogModel - filterMatches", () => {
  const cost = (kind: ProviderCatalogCost["kind"]): ProviderCatalogCost => ({
    kind,
    label: kind,
    detail: null,
  });

  it("All matches every cost kind including unknown", () => {
    expect(filterMatches("all", cost("subscription"))).toBe(true);
    expect(filterMatches("all", cost("free"))).toBe(true);
    expect(filterMatches("all", cost("freeTier"))).toBe(true);
    expect(filterMatches("all", cost("apiKey"))).toBe(true);
    expect(filterMatches("all", cost("payAsYouGo"))).toBe(true);
    expect(filterMatches("all", cost("byok"))).toBe(true);
    expect(filterMatches("all", cost("unknown"))).toBe(true);
  });

  it("Subscription matches only subscription kind", () => {
    expect(filterMatches("subscription", cost("subscription"))).toBe(true);
    expect(filterMatches("subscription", cost("free"))).toBe(false);
    expect(filterMatches("subscription", cost("apiKey"))).toBe(false);
    expect(filterMatches("subscription", cost("unknown"))).toBe(false);
  });

  it("API key matches apiKey, byok, and payAsYouGo", () => {
    expect(filterMatches("apiKey", cost("apiKey"))).toBe(true);
    expect(filterMatches("apiKey", cost("byok"))).toBe(true);
    expect(filterMatches("apiKey", cost("payAsYouGo"))).toBe(true);
    expect(filterMatches("apiKey", cost("subscription"))).toBe(false);
    expect(filterMatches("apiKey", cost("free"))).toBe(false);
    expect(filterMatches("apiKey", cost("unknown"))).toBe(false);
  });

  it("Free matches free, freeTier, and byok (free to start)", () => {
    expect(filterMatches("free", cost("free"))).toBe(true);
    expect(filterMatches("free", cost("freeTier"))).toBe(true);
    expect(filterMatches("free", cost("byok"))).toBe(true);
    expect(filterMatches("free", cost("subscription"))).toBe(false);
    expect(filterMatches("free", cost("apiKey"))).toBe(false);
    expect(filterMatches("free", cost("unknown"))).toBe(false);
  });
});

describe("catalogModel - search and highlighting", () => {
  it("normalizes case, whitespace, and accents", () => {
    expect(normalizeSearch("  GÉMINI cli  ")).toBe("gemini cli");
  });

  const sample = entry({
    catalogId: "google-gemini",
    name: "Gemini CLI",
    publisher: "Google",
    description: "Google's coding agent for Gemini models.",
  });

  it("matches on name, publisher, description, and catalogId", () => {
    expect(entryMatchesSearch(sample, "gemini")).toBe(true);
    expect(entryMatchesSearch(sample, "gÉmIni")).toBe(true);
    expect(entryMatchesSearch(sample, "Google")).toBe(true);
    expect(entryMatchesSearch(sample, "coding agent")).toBe(true);
    expect(entryMatchesSearch(sample, "google-gemini")).toBe(true);
    expect(entryMatchesSearch(sample, "copilot")).toBe(false);
  });

  it("highlights matched part of the name", () => {
    const parts = highlightNameMatch("Gemini CLI", "mini");
    expect(parts).toEqual([
      { text: "Ge", matched: false },
      { text: "mini", matched: true },
      { text: " CLI", matched: false },
    ]);
  });
});

describe("catalogModel - partitionCatalog", () => {
  const e1 = entry({
    catalogId: "cursor",
    name: "Cursor",
    popularRank: 1,
    cost: { kind: "subscription", label: "", detail: null },
  });
  const e2 = entry({
    catalogId: "gemini",
    name: "Gemini CLI",
    popularRank: 2,
    cost: { kind: "freeTier", label: "", detail: null },
  });
  const e3 = entry({
    catalogId: "copilot",
    name: "Copilot",
    popularRank: 3,
    cost: { kind: "subscription", label: "", detail: null },
  });
  const e4 = entry({
    catalogId: "zebra",
    name: "Zebra Agent",
    popularRank: null,
    cost: { kind: "free", label: "", detail: null },
  });
  const e5 = entry({
    catalogId: "alpha",
    name: "Alpha Tool",
    popularRank: null,
    cost: { kind: "apiKey", label: "", detail: null },
  });
  const all = [e4, e2, e5, e1, e3];

  it("sections mode for filter=all and no query", () => {
    const p = partitionCatalog(all, "all", "");
    expect(p.mode).toBe("sections");
    if (p.mode === "sections") {
      expect(p.popular.map((e) => e.catalogId)).toEqual(["cursor", "gemini", "copilot"]);
      expect(p.allAtoZ.map((e) => e.name)).toEqual([
        "Alpha Tool",
        "Copilot",
        "Cursor",
        "Gemini CLI",
        "Zebra Agent",
      ]);
    }
  });

  it("filtered mode with title count for chip filters", () => {
    const p = partitionCatalog(all, "free", "");
    expect(p.mode).toBe("filtered");
    if (p.mode === "filtered") {
      expect(p.title).toBe("Free to start · 2");
      expect(p.items.map((e) => e.catalogId)).toEqual(["gemini", "zebra"]);
    }
  });

  it("search mode with results count when query is present", () => {
    const p = partitionCatalog(all, "all", "alpha");
    expect(p.mode).toBe("search");
    if (p.mode === "search") {
      expect(p.title).toBe("Results · 1");
      expect(p.items[0]?.catalogId).toBe("alpha");
    }
  });

  it("search mode with 0 results for non-matching query", () => {
    const p = partitionCatalog(all, "all", "zed agent");
    expect(p.mode).toBe("search");
    if (p.mode === "search") {
      expect(p.title).toBe("Results · 0");
      expect(p.items).toHaveLength(0);
    }
  });
});

describe("catalogModel - unsupportedReasonCopy", () => {
  it("returns plain-words reason for needsUv", () => {
    const res = unsupportedReasonCopy("needsUv");
    expect(res.title).toBe("Can't install from the phone yet");
    expect(res.text).toBe("It needs uv, a Python tool that isn't on your laptop.");
    expect(res.buttonLabel).toBe("Ask CTO to set it up");
  });

  it("returns plain-words reason for noChecksum", () => {
    const res = unsupportedReasonCopy("noChecksum");
    expect(res.text).toBe("The registry doesn't list a checksum for this download.");
  });

  it("returns plain-words reason for needsNode", () => {
    const res = unsupportedReasonCopy("needsNode");
    expect(res.text).toBe("It needs Node.js, which isn't on your laptop.");
  });
});

describe("catalogModel - catalogInstallFailureNote", () => {
  it("formats network failure", () => {
    const note = catalogInstallFailureNote(
      { kind: "network", host: "github.com", detail: "ETIMEDOUT" },
      null,
      "Gemini CLI",
    );
    expect(note.title).toBe("The download stopped");
    expect(note.text).toBe('Your laptop lost its connection to github.com. It said "ETIMEDOUT".');
    expect(note.buttons).toEqual(["tryAgain"]);
  });

  it("formats disk failure", () => {
    const note = catalogInstallFailureNote(
      { kind: "disk", neededBytes: 334_000_000, freeBytes: 120_000_000, detail: "" },
      null,
      "Junie",
    );
    expect(note.title).toBe("Not enough space on your laptop");
    expect(note.text).toBe("Junie needs 334 MB and the laptop has 120 MB free.");
  });

  it("formats wontStart failure with remove button", () => {
    const note = catalogInstallFailureNote(
      { kind: "wontStart", detail: "unsupported platform" },
      null,
      "Kimi CLI",
    );
    expect(note.title).toBe("Installed, but it won't start");
    expect(note.text).toBe(
      'Kimi CLI stopped with "unsupported platform". This version may not run on Windows.',
    );
    expect(note.buttons).toEqual(["tryAgain", "removeIt"]);
  });
});
