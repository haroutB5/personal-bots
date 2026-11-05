// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@t3tools/shared/nodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { claudeCliVersion, parseGenericCliVersion } from "./claudeCliVersion.ts";

describe("parseGenericCliVersion", () => {
  it("reads the version out of the usual CLI banners", () => {
    expect(parseGenericCliVersion("2.1.100 (Claude Code)")).toBe("2.1.100");
    expect(parseGenericCliVersion("claude v2.1.100")).toBe("2.1.100");
    expect(parseGenericCliVersion("no version here")).toBeNull();
  });
});

const fakeClaude = (script: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-cli-version-"));
  const binary = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(binary, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return binary;
};

describe("claudeCliVersion", () => {
  it.effect("spawns the binary with --version and parses the answer", () =>
    Effect.gen(function* () {
      const binary = fakeClaude('[ "$1" = "--version" ] && echo "2.1.100 (Claude Code)"');
      expect(yield* claudeCliVersion({ binaryPath: binary, homePath: "" })).toBe("2.1.100");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes the instance home to the CLI as CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const binary = fakeClaude(
        'echo "$CLAUDE_CONFIG_DIR" | grep -q "/custom-home" && echo "3.0.1"',
      );
      expect(yield* claudeCliVersion({ binaryPath: binary, homePath: "/tmp/custom-home" })).toBe(
        "3.0.1",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a failed run as unknown", () =>
    Effect.gen(function* () {
      const failing = fakeClaude('echo "2.1.100"; exit 3');
      expect(yield* claudeCliVersion({ binaryPath: failing, homePath: "" })).toBeNull();
      expect(
        yield* claudeCliVersion({ binaryPath: "/nonexistent/claude-binary", homePath: "" }),
      ).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
