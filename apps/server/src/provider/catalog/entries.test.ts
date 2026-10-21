import { describe, expect, it } from "@effect/vitest";
import { ProviderCatalogEntry, ProviderCatalogListResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BUILT_IN_DESCRIPTORS, buildCatalogEntries, registryAgentForCatalogId } from "./entries.ts";
import {
  BUNDLED_CATALOG_OVERLAY,
  newerOverlay,
  parseOverlay,
  parseOverlayText,
} from "./overlay.ts";
import { parseRegistry } from "./registry.ts";
import registryFixture from "./fixtures/registry-2026-10-20.json" with { type: "json" };

const isWireEntry = Schema.is(ProviderCatalogEntry);
const isWireList = Schema.is(ProviderCatalogListResult);
const registry = parseRegistry(registryFixture)!;
const win = "windows-x86_64" as const;

const build = (patch: Partial<Parameters<typeof buildCatalogEntries>[0]> = {}) =>
  buildCatalogEntries({ registry, overlay: BUNDLED_CATALOG_OVERLAY, platform: win, ...patch });

describe("buildCatalogEntries", () => {
  it("lists the built-ins plus the registry, minus registry copies of built-ins and hidden entries", () => {
    const entries = build();
    const ids = entries.map((entry) => entry.catalogId);
    // 7 built-ins + 42 registry agents - 6 built-in copies - 1 hidden (Agoragentic).
    expect(entries).toHaveLength(7 + 42 - 6 - 1);
    expect(entries.filter((entry) => entry.source === "builtIn")).toHaveLength(7);
    for (const copy of [
      "claude-acp",
      "codex-acp",
      "opencode",
      "cursor",
      "antigravity-acp",
      "grok-build",
    ]) {
      expect(ids).not.toContain(copy);
    }
    expect(ids).not.toContain("agoragentic-acp");
    expect(ids).toContain("builtin:cursor");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts Popular first by rank, then everything A to Z", () => {
    const entries = build();
    expect(entries.slice(0, 6).map((entry) => entry.catalogId)).toEqual([
      "builtin:cursor",
      "gemini",
      "github-copilot-cli",
      "qwen-code",
      "kimi",
      "mistral-vibe",
    ]);
    expect(entries.slice(0, 6).map((entry) => entry.popularRank)).toEqual([1, 2, 3, 4, 5, 6]);
    const rest = entries.slice(6).map((entry) => entry.name);
    expect(rest).toEqual(
      [...rest].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    );
    expect(entries.slice(6).every((entry) => entry.popularRank === null)).toBe(true);
  });

  it("says unknown, never guesses, for what the registry and overlay do not know", () => {
    const entries = new Map(build().map((entry) => [entry.catalogId, entry]));
    const goose = entries.get("goose")!;
    expect(goose.downloadBytes).toBeNull();
    expect(goose.cost).toEqual({ kind: "unknown", label: "Price not listed", detail: null });
    expect(goose.signInLabel).toBeNull();
    expect(goose.popularRank).toBeNull();
    const gemini = entries.get("gemini")!;
    expect(gemini.cost.kind).toBe("freeTier");
    expect(gemini.cost.label).toBe("Free with a Google account");
    expect(gemini.signInLabel).toBe("Google account or API key");
  });

  it("takes download sizes only from the probes, and only for binary downloads", () => {
    const url = registry.agents.find((agent) => agent.id === "goose")!.binary[win]!.archive;
    const entries = new Map(
      build({ sizes: new Map([[url, 76_483_830]]) }).map((entry) => [entry.catalogId, entry]),
    );
    expect(entries.get("goose")!.downloadBytes).toBe(76_483_830);
    expect(entries.get("amp-acp")!.downloadBytes).toBeNull();
    // npm never has a number: the tree is not known before npm resolves it.
    expect(entries.get("gemini")!.downloadBytes).toBeNull();
  });

  it("describes where each download comes from", () => {
    const entries = new Map(build().map((entry) => [entry.catalogId, entry]));
    expect(entries.get("goose")!.distribution).toEqual({
      kind: "binary",
      label: "GitHub release · block/goose",
    });
    expect(entries.get("gemini")!.distribution).toEqual({
      kind: "npm",
      label: "npm · @google/gemini-cli",
    });
    expect(entries.get("fast-agent")!.distribution).toEqual({
      kind: "uvx",
      label: "uv · fast-agent-acp",
    });
    expect(entries.get("junie")!.distribution).toEqual({
      kind: "binary",
      label: "GitHub release · JetBrains/junie-acp-release",
    });
    expect(entries.get("devin")!.distribution).toEqual({
      kind: "binary",
      label: "Download · static.devin.ai",
    });
  });

  it("marks sha256Checked for binary archives with a fingerprint, and support with a reason when not", () => {
    const entries = new Map(build().map((entry) => [entry.catalogId, entry]));
    expect(entries.get("goose")).toMatchObject({ sha256Checked: true, supported: { ok: true } });
    expect(entries.get("gemini")).toMatchObject({ sha256Checked: false, supported: { ok: true } });
    expect(entries.get("junie")).toMatchObject({
      sha256Checked: false,
      supported: { ok: false, reason: "noChecksum" },
    });
    expect(entries.get("fast-agent")).toMatchObject({
      supported: { ok: false, reason: "needsUv" },
    });
    expect(entries.get("minion-code")).toMatchObject({
      supported: { ok: false, reason: "needsUv" },
    });
    expect(
      build({ nodeAvailable: false }).find((entry) => entry.catalogId === "gemini")!.supported,
    ).toEqual({
      ok: false,
      reason: "needsNode",
    });
  });

  it("reports licence and open source from the registry's own words", () => {
    const entries = new Map(build().map((entry) => [entry.catalogId, entry]));
    expect(entries.get("gemini")).toMatchObject({ license: "Apache-2.0", openSource: true });
    expect(entries.get("junie")).toMatchObject({ license: "proprietary", openSource: false });
    // The registry spells it both ways.
    expect(entries.get("codebuddy-code")).toMatchObject({
      license: "Proprietary",
      openSource: false,
    });
    expect(entries.get("fast-agent")).toMatchObject({ license: "Apache 2.0", openSource: true });
  });

  it("strips e-mail addresses from the publisher", () => {
    const entries = new Map(build().map((entry) => [entry.catalogId, entry]));
    expect(entries.get("auggie")!.publisher).toBe("Augment Code");
    expect(entries.get("poolside")!.publisher).toBe("Poolside");
    expect(entries.get("fast-agent")!.publisher).not.toContain("@");
  });

  it("marks entries already added with their instance", () => {
    const entries = new Map(
      build({
        added: new Map([
          ["gemini", "gemini-2"],
          ["builtin:codex", "codex"],
        ]),
      }).map((entry) => [entry.catalogId, entry]),
    );
    expect(entries.get("gemini")!.added).toEqual({ instanceId: "gemini-2" });
    expect(entries.get("builtin:codex")!.added).toEqual({ instanceId: "codex" });
    expect(entries.get("goose")!.added).toBeNull();
  });

  it("proxies icons through the server, never the registry CDN", () => {
    const entries = build();
    for (const entry of entries) {
      if (entry.iconUrl !== null) {
        expect(entry.iconUrl).toBe(
          `/api/provider-catalog/icon/${encodeURIComponent(entry.catalogId)}`,
        );
      }
    }
    const byId = new Map(entries.map((entry) => [entry.catalogId, entry]));
    expect(byId.get("builtin:claudeAgent")!.iconUrl).not.toBeNull();
    // DeepSeek has no registry copy, so no icon: the phone draws a monogram.
    expect(byId.get("builtin:deepseek")!.iconUrl).toBeNull();
  });

  it("lists only the built-ins when there is no registry copy yet", () => {
    const entries = build({ registry: null });
    expect(entries).toHaveLength(7);
    expect(entries.every((entry) => entry.source === "builtIn" && entry.supported.ok)).toBe(true);
  });

  it("lets the overlay hide a built-in or retitle an entry", () => {
    const overlay = parseOverlay({
      version: 1,
      entries: {
        "builtin:grok": { hidden: true },
        goose: { publisher: "Block Inc.", description: "Goose." },
      },
    })!;
    const entries = new Map(build({ overlay }).map((entry) => [entry.catalogId, entry]));
    expect(entries.has("builtin:grok")).toBe(false);
    expect(entries.get("goose")).toMatchObject({ publisher: "Block Inc.", description: "Goose." });
  });
});

describe("wire contract", () => {
  it("every entry built from the real registry decodes with the contract schema", () => {
    const entries = build({ added: new Map([["gemini", "gemini"]]) });
    for (const entry of entries) {
      expect(isWireEntry(entry), entry.catalogId).toBe(true);
    }
    const result = { entries, registryFetchedAt: "2026-10-20T08:00:00.000Z", registryStale: false };
    expect(isWireList(result)).toBe(true);
  });
});

describe("registryAgentForCatalogId", () => {
  it("maps a built-in to its registry copy and a registry id to itself", () => {
    expect(registryAgentForCatalogId("builtin:claudeAgent", registry)?.id).toBe("claude-acp");
    expect(registryAgentForCatalogId("goose", registry)?.id).toBe("goose");
    expect(registryAgentForCatalogId("builtin:deepseek", registry)).toBeNull();
    expect(registryAgentForCatalogId("nope", registry)).toBeNull();
    expect(registryAgentForCatalogId("goose", null)).toBeNull();
  });

  it("knows every built-in's registry copy exists in today's registry", () => {
    for (const builtIn of BUILT_IN_DESCRIPTORS) {
      if (builtIn.registryId !== null) {
        expect(
          registry.agents.some((agent) => agent.id === builtIn.registryId),
          builtIn.driver,
        ).toBe(true);
      }
    }
  });
});

describe("overlay", () => {
  it("bundles an overlay that decodes and names no agent that is gone", () => {
    for (const id of Object.keys(BUNDLED_CATALOG_OVERLAY.entries)) {
      const known = id.startsWith("builtin:") || registry.agents.some((agent) => agent.id === id);
      expect(known, id).toBe(true);
    }
  });

  it("drops an overlay that does not decode and keeps the bundled one", () => {
    expect(parseOverlayText("{")).toBeNull();
    expect(parseOverlayText('{"version":2,"entries":{}}')).toBeNull();
    expect(parseOverlay({ version: 1, entries: { x: { popularRank: 0 } } })).toBeNull();
    expect(parseOverlay({ version: 1, entries: { x: { apiKey: { env: "lower" } } } })).toBeNull();
    expect(
      parseOverlay({
        version: 1,
        entries: { x: { apiKey: { env: "KEY", keyPageUrl: "http://x" } } },
      }),
    ).toBeNull();
  });

  it("prefers a cached overlay only when it is newer than the bundle", () => {
    const bundled = parseOverlay({ version: 1, updatedAt: "2026-10-20", entries: {} })!;
    const newer = parseOverlay({ version: 1, updatedAt: "2026-10-21", entries: { a: {} } })!;
    const older = parseOverlay({ version: 1, updatedAt: "2026-10-01", entries: { b: {} } })!;
    const undated = parseOverlay({ version: 1, entries: { c: {} } })!;
    expect(newerOverlay(bundled, newer)).toBe(newer);
    expect(newerOverlay(bundled, older)).toBe(bundled);
    expect(newerOverlay(bundled, undated)).toBe(bundled);
    expect(newerOverlay(bundled, null)).toBe(bundled);
  });
});
