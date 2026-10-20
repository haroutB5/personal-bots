import { describe, expect, it } from "@effect/vitest";

import {
  normalizeRelativeCommand,
  requiredFreeBytes,
  resolveInstallPlan,
  safeRegistryEnv,
} from "./plan.ts";
import {
  archiveFormatOf,
  parseExactNpmSpec,
  parseRegistry,
  parseRegistryText,
  registryPlatformKey,
  type RegistryAgent,
} from "./registry.ts";
import registryFixture from "./fixtures/registry-2026-10-20.json" with { type: "json" };

// The real registry as fetched on 2026-10-20: 42 agents, 19 with binary
// archives (all with a Windows x64 build), 23 with an npm package, 2 with uv.
const parsed = parseRegistry(registryFixture)!;
const byId = new Map(parsed.agents.map((agent) => [agent.id, agent]));
const agent = (id: string): RegistryAgent => {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`fixture has no ${id}`);
  return found;
};
const win = "windows-x86_64" as const;

describe("parseRegistry", () => {
  it("reads every agent of the real registry", () => {
    expect(parsed.agents).toHaveLength(42);
    expect(parsed.skipped).toBe(0);
    expect(
      parsed.agents.filter((candidate) => Object.keys(candidate.binary).length > 0),
    ).toHaveLength(19);
    expect(parsed.agents.filter((candidate) => candidate.npm !== null)).toHaveLength(23);
    expect(parsed.agents.filter((candidate) => candidate.uvx !== null)).toHaveLength(2);
  });

  it("has a Windows x64 build for every binary agent, 10 of them with a sha256", () => {
    const binaries = parsed.agents.filter((candidate) => Object.keys(candidate.binary).length > 0);
    expect(binaries.every((candidate) => candidate.binary[win] !== undefined)).toBe(true);
    expect(binaries.filter((candidate) => candidate.binary[win]?.sha256 != null)).toHaveLength(10);
  });

  it("skips a malformed agent and keeps the rest", () => {
    const result = parseRegistry({
      version: "1.0.0",
      agents: [
        { id: "ok", name: "Ok", version: "1.0.0", distribution: { npx: { package: "ok@1.0.0" } } },
        { id: "no-version", name: "Bad", distribution: {} },
        { id: "../escape", name: "Bad", version: "1.0.0", distribution: {} },
        { id: "ok", name: "Duplicate", version: "2.0.0", distribution: {} },
        "not an object",
      ],
    });
    expect(result?.agents.map((candidate) => candidate.id)).toEqual(["ok"]);
    expect(result?.skipped).toBe(4);
  });

  it("is null when the document is not a registry or has no usable agent", () => {
    expect(parseRegistry(null)).toBeNull();
    expect(parseRegistry({ version: "1.0.0" })).toBeNull();
    expect(parseRegistry({ version: "1.0.0", agents: [] })).toBeNull();
    expect(parseRegistry({ version: "1.0.0", agents: [{ id: "x" }] })).toBeNull();
    expect(parseRegistryText("not json")).toBeNull();
    expect(parseRegistryText("")).toBeNull();
  });

  it("ignores a platform target it cannot read without dropping the agent", () => {
    const result = parseRegistry({
      version: "1.0.0",
      agents: [
        {
          id: "a",
          name: "A",
          version: "1.0.0",
          distribution: {
            binary: {
              "windows-x86_64": { archive: "https://example.com/a.zip", cmd: "./a.exe" },
              "linux-x86_64": { archive: 5 },
            },
          },
        },
      ],
    });
    const only = result!.agents[0]!;
    expect(only.binary["windows-x86_64"]?.cmd).toBe("./a.exe");
    expect(only.binary["linux-x86_64"]).toBeUndefined();
  });
});

describe("registryPlatformKey", () => {
  it("maps node platform and arch to registry keys", () => {
    expect(registryPlatformKey("win32", "x64")).toBe("windows-x86_64");
    expect(registryPlatformKey("win32", "arm64")).toBe("windows-aarch64");
    expect(registryPlatformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(registryPlatformKey("linux", "x64")).toBe("linux-x86_64");
    expect(registryPlatformKey("freebsd", "x64")).toBeNull();
    expect(registryPlatformKey("linux", "ia32")).toBeNull();
  });
});

describe("parseExactNpmSpec", () => {
  it("accepts only name@exact-version", () => {
    expect(parseExactNpmSpec("@google/gemini-cli@0.64.0")).toEqual({
      name: "@google/gemini-cli",
      version: "0.64.0",
    });
    expect(parseExactNpmSpec("cline@3.0.73")).toEqual({ name: "cline", version: "3.0.73" });
    expect(parseExactNpmSpec("pkg@1.2.3-rc.1")).toEqual({ name: "pkg", version: "1.2.3-rc.1" });
    for (const bad of [
      "pkg",
      "pkg@latest",
      "pkg@^1.0.0",
      "pkg@1.x",
      "pkg@>=1.0.0",
      "github:evil/pkg@1.0.0",
      "https://evil.example/p.tgz@1.0.0",
      "--flag@1.0.0",
      "pkg@npm:other@1.0.0",
      "file:../x@1.0.0",
      "@scope@1.0.0",
      "@@scope/pkg@1.0.0",
    ]) {
      expect(parseExactNpmSpec(bad), bad).toBeNull();
    }
  });

  it("finds an exact version for every npm agent in the real registry", () => {
    for (const candidate of parsed.agents) {
      if (candidate.npm === null) continue;
      expect(candidate.npm.version, candidate.id).not.toBeNull();
      expect(candidate.npm.version, candidate.id).toBe(candidate.version);
    }
  });
});

describe("archiveFormatOf", () => {
  it("reads the format from the path, not the query", () => {
    expect(archiveFormatOf("https://x.example/a.zip?sig=1")).toBe("zip");
    expect(archiveFormatOf("https://x.example/a%2B1.tar.gz")).toBe("tar.gz");
    expect(archiveFormatOf("https://x.example/a.tgz")).toBe("tar.gz");
    expect(archiveFormatOf("https://x.example/sigit-win-amd64.exe")).toBe("raw");
    expect(archiveFormatOf("https://x.example/a.tar.bz2")).toBe("unsupported");
    expect(archiveFormatOf("https://x.example/a.dmg")).toBe("unsupported");
    expect(archiveFormatOf("https://x.example/a.msi")).toBe("unsupported");
    expect(archiveFormatOf("not a url")).toBe("unsupported");
  });

  it("knows the format of every Windows archive in the real registry", () => {
    const formats = parsed.agents.flatMap((candidate) => {
      const target = candidate.binary[win];
      return target === undefined ? [] : [archiveFormatOf(target.archive)];
    });
    expect(formats.filter((format) => format === "zip")).toHaveLength(16);
    expect(formats.filter((format) => format === "tar.gz")).toHaveLength(2);
    expect(formats.filter((format) => format === "raw")).toHaveLength(1);
  });
});

describe("normalizeRelativeCommand", () => {
  it("accepts the registry's Windows launch paths", () => {
    expect(normalizeRelativeCommand("./dist-package\\cursor-agent.cmd")).toBe(
      "dist-package/cursor-agent.cmd",
    );
    expect(normalizeRelativeCommand("./bin\\devin.exe")).toBe("bin/devin.exe");
    expect(normalizeRelativeCommand("harn.exe")).toBe("harn.exe");
    expect(
      normalizeRelativeCommand("./coco-1.0.73+180523.e6179a031de9-windows-amd64/cortex.exe"),
    ).toBe("coco-1.0.73+180523.e6179a031de9-windows-amd64/cortex.exe");
  });

  it("refuses paths that leave the folder or name a device", () => {
    for (const bad of [
      "../x.exe",
      "a/../../x.exe",
      "/abs/x.exe",
      "\\\\server\\share\\x.exe",
      "C:\\x.exe",
      "c:x.exe",
      "a/b:stream",
      "nul",
      "CON.txt",
      "a/aux/x.exe",
      "",
      ".",
      "./",
      "trailing.",
      "x\0y",
    ]) {
      expect(normalizeRelativeCommand(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("requiredFreeBytes", () => {
  const binary = resolveInstallPlan(agent("goose"), { platform: win });
  const npm = resolveInstallPlan(agent("gemini"), { platform: win });
  it("asks for 2.5 times the download, or a large-agent floor when the size is unknown", () => {
    if (binary.kind !== "binary" || npm.kind !== "npm") throw new Error("fixture plans changed");
    expect(requiredFreeBytes(binary, 100_000_000)).toBe(250_000_000);
    expect(requiredFreeBytes(binary, 1)).toBe(3);
    expect(requiredFreeBytes(binary, null)).toBe(1536 * 1024 * 1024);
    expect(requiredFreeBytes(npm, null)).toBe(600 * 1024 * 1024);
  });
});

describe("safeRegistryEnv", () => {
  it("drops variables that change how every program starts", () => {
    expect(
      safeRegistryEnv({
        AUGMENT_DISABLE_AUTO_UPDATE: "1",
        PATH: "C:\\evil",
        Path: "C:\\evil",
        NODE_OPTIONS: "--require x",
        LD_PRELOAD: "x",
        DYLD_INSERT_LIBRARIES: "x",
        npm_config_registry: "https://evil.example",
        "BAD NAME": "x",
        FINE: "ok",
      }),
    ).toEqual({ AUGMENT_DISABLE_AUTO_UPDATE: "1", FINE: "ok" });
  });
});

describe("resolveInstallPlan on the real registry (Windows x64)", () => {
  const plan = (id: string, overlay?: Parameters<typeof resolveInstallPlan>[1]["overlay"]) =>
    resolveInstallPlan(agent(id), { platform: win, ...(overlay === undefined ? {} : { overlay }) });

  it("installs a binary with a registry sha256 from the archive", () => {
    const result = plan("goose");
    expect(result).toMatchObject({
      kind: "binary",
      format: "zip",
      sha256Source: "registry",
      command: "goose-package/goose.exe",
      args: ["acp"],
      host: "github.com",
    });
  });

  it("prefers the verified binary over npm when an agent has both", () => {
    expect(plan("kilo").kind).toBe("binary");
    expect(plan("sigit")).toMatchObject({
      kind: "binary",
      format: "raw",
      command: "sigit-win-amd64.exe",
    });
  });

  it("installs npm agents from the exact pinned version", () => {
    expect(plan("gemini")).toEqual({
      kind: "npm",
      name: "@google/gemini-cli",
      version: "0.64.0",
      args: ["--acp"],
      env: {},
    });
    expect(plan("factory-droid")).toMatchObject({
      kind: "npm",
      args: ["exec", "--output-format", "acp-daemon"],
      env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    });
  });

  it("cannot install a binary the registry gives no sha256 for", () => {
    for (const id of [
      "cortex-code",
      "corust-agent",
      "crow-cli",
      "devin",
      "junie",
      "stakpak",
      "vtcode",
    ]) {
      expect(plan(id), id).toEqual({ kind: "unsupported", reason: "noChecksum" });
    }
  });

  it("installs such a binary when the overlay pins the fingerprint for that exact version", () => {
    const sha = "a".repeat(64);
    const pinned = plan("junie", { sha256Pins: { "3659.7.0": { [win]: sha.toUpperCase() } } });
    expect(pinned).toMatchObject({ kind: "binary", sha256: sha, sha256Source: "overlay" });
    // A pin for another version does nothing.
    expect(plan("junie", { sha256Pins: { "1.0.0": { [win]: sha } } })).toEqual({
      kind: "unsupported",
      reason: "noChecksum",
    });
    // A registry sha256 always wins over a pin.
    expect(plan("goose", { sha256Pins: { "1.55.0": { [win]: sha } } })).toMatchObject({
      sha256Source: "registry",
    });
  });

  it("marks the two uv agents unsupported", () => {
    expect(plan("fast-agent")).toEqual({ kind: "unsupported", reason: "needsUv" });
    expect(plan("minion-code")).toEqual({ kind: "unsupported", reason: "needsUv" });
  });

  it("needs Node for npm agents and says so", () => {
    expect(resolveInstallPlan(agent("gemini"), { platform: win, nodeAvailable: false })).toEqual({
      kind: "unsupported",
      reason: "needsNode",
    });
  });

  it("has no build for a platform the registry does not list", () => {
    expect(resolveInstallPlan(agent("goose"), { platform: null })).toEqual({
      kind: "unsupported",
      reason: "noWindowsBuild",
    });
    expect(resolveInstallPlan(agent("amp-acp"), { platform: "linux-x86_64" }).kind).toBe("binary");
  });

  it("classifies all 42 agents with no surprise", () => {
    const counts: Record<string, number> = {};
    for (const candidate of parsed.agents) {
      const result = resolveInstallPlan(candidate, { platform: win });
      const key = result.kind === "unsupported" ? `unsupported:${result.reason}` : result.kind;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      binary: 10,
      npm: 21,
      "unsupported:noChecksum": 9,
      "unsupported:needsUv": 2,
    });
  });

  it("refuses a registry entry that is not HTTPS, or that escapes its folder", () => {
    const base = agent("goose");
    const target = base.binary[win]!;
    const withTarget = (patch: Partial<typeof target>): RegistryAgent => ({
      ...base,
      binary: { [win]: { ...target, ...patch } },
    });
    expect(
      resolveInstallPlan(withTarget({ archive: "http://github.com/a.zip" }), { platform: win }),
    ).toEqual({
      kind: "unsupported",
      reason: "badDistribution",
    });
    expect(
      resolveInstallPlan(withTarget({ archive: "https://user:pw@github.com/a.zip" }), {
        platform: win,
      }),
    ).toEqual({
      kind: "unsupported",
      reason: "badDistribution",
    });
    expect(resolveInstallPlan(withTarget({ cmd: "../../evil.exe" }), { platform: win })).toEqual({
      kind: "unsupported",
      reason: "badDistribution",
    });
    expect(resolveInstallPlan(withTarget({ args: ["x\0y"] }), { platform: win })).toEqual({
      kind: "unsupported",
      reason: "badDistribution",
    });
    expect(
      resolveInstallPlan(withTarget({ archive: "https://github.com/a.tar.bz2" }), {
        platform: win,
      }),
    ).toEqual({
      kind: "unsupported",
      reason: "unsupportedArchive",
    });
  });
});
