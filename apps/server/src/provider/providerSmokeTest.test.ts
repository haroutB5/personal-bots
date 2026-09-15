import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeSmokeTestQueryOptions,
  buildCodexSmokeTestArgs,
  claudeSmokeTestFailure,
} from "./providerSmokeTest.ts";

const result = (fields: Record<string, unknown>) =>
  ({ type: "result", duration_ms: 1, is_error: false, ...fields }) as unknown as SDKMessage;

describe("Claude smoke test options", () => {
  it("uses the personal-bot isolation: no settings files, no MCP, no tools, one turn", () => {
    const options = buildClaudeSmokeTestQueryOptions({
      executablePath: "C:/Users/me/.local/bin/claude.exe",
      environment: { PATH: "x", ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
      cwd: "C:/tmp/smoke",
      model: "claude-opus-5",
      abortController: new AbortController(),
    });
    expect(options.pathToClaudeCodeExecutable).toBe("C:/Users/me/.local/bin/claude.exe");
    expect(options.model).toBe("claude-opus-5");
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.persistSession).toBe(false);
    expect(options.settings).toEqual({ autoMemoryEnabled: false, disableClaudeAiConnectors: true });
    // The bot overrides win over the owner's environment.
    expect(options.env).toMatchObject({
      PATH: "x",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });
});

describe("claudeSmokeTestFailure", () => {
  it("passes on a non-empty successful reply", () => {
    expect(claudeSmokeTestFailure([result({ subtype: "success", result: "ready" })])).toBeNull();
  });

  it("fails on an empty reply, an error result, or no result at all", () => {
    expect(claudeSmokeTestFailure([result({ subtype: "success", result: "  " })])).toBe(
      "Claude Code replied with an empty message.",
    );
    expect(
      claudeSmokeTestFailure([
        result({ subtype: "success", is_error: true, result: "API Error: 500" }),
      ]),
    ).toBe("API Error: 500");
    expect(
      claudeSmokeTestFailure([
        result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] }),
      ]),
    ).toBe("boom");
    expect(claudeSmokeTestFailure([])).toBe("Claude Code ended without replying.");
  });

  it("reads the last result when several arrive", () => {
    expect(
      claudeSmokeTestFailure([
        result({ subtype: "error_during_execution", is_error: true, errors: ["first"] }),
        result({ subtype: "success", result: "ready" }),
      ]),
    ).toBeNull();
  });
});

describe("buildCodexSmokeTestArgs", () => {
  it("runs a read-only ephemeral exec with the personal-bot overrides and skills off", () => {
    const args = buildCodexSmokeTestArgs({
      launchArgs: undefined,
      model: "gpt-5.5",
      skillFiles: ["C:/Users/me/.codex/skills/a/SKILL.md"],
    });
    expect(args[0]).toBe("exec");
    expect(args).toContain("features.plugins=false");
    expect(args).toContain("features.apps=false");
    expect(args).toContain("features.memories=false");
    expect(args.some((arg) => arg.startsWith("skills.config=["))).toBe(true);
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).toContain("-s read-only");
    expect(args.join(" ")).toContain("--model gpt-5.5");
    expect(args.at(-1)).toBe("-");
  });
});
