import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeSmokeTestQueryOptions,
  buildCodexSmokeTestArgs,
  buildOpenCodeSmokeTestArgs,
  claudeSmokeTestFailure,
  lastLines,
  openCodeSmokeTestFailure,
  SMOKE_TEST_PROMPT,
  openCodeSmokeTestEnvironment,
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

describe("OpenCode smoke test", () => {
  it("does not deny every tool, which OpenCode's free tier refuses outright", () => {
    // Denying all tools made the probe fail with a 403 FreeTierError -- "can
    // only be used from within OpenCode" -- while real bot turns, which allow
    // tools, worked fine. A check that runs under conditions no session uses
    // was not checking the thing it claimed to.
    const config = JSON.parse(
      openCodeSmokeTestEnvironment({
        environment: {},
        configHome: "C:/bots-home",
        model: "opencode/muse-spark-1.3-contributor-free",
      }).OPENCODE_CONFIG_CONTENT ?? "{}",
    ) as Record<string, unknown>;

    expect(config["permission"]).toBeUndefined();
  });

  it("runs one JSON-formatted turn on the bot's model", () => {
    expect(
      buildOpenCodeSmokeTestArgs({ model: "opencode/muse-spark-1.3-contributor-free" }),
    ).toEqual([
      "run",
      "-m",
      "opencode/muse-spark-1.3-contributor-free",
      "--format",
      "json",
      SMOKE_TEST_PROMPT,
    ]);
  });

  // Shapes captured from opencode 1.18.29 `run --format json` on 2026-09-15.
  const ok = [
    '{"type":"step_start","timestamp":1,"sessionID":"ses_1","part":{"type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"ses_1","part":{"type":"text","text":"ready"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"ses_1","part":{"type":"step-finish"}}',
  ].join("\n");
  const bogusModel =
    '{"type":"error","timestamp":1789487237708,"sessionID":"ses_2","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_8868fe38"}}}';

  it("passes on a non-empty reply", () => {
    expect(openCodeSmokeTestFailure({ stdout: ok, stderr: "", exitCode: 0 })).toBeNull();
  });

  it("fails with OpenCode's own error text, even when it exits non-zero", () => {
    expect(openCodeSmokeTestFailure({ stdout: bogusModel, stderr: "noise", exitCode: 1 })).toBe(
      "Unexpected server error. Check server logs for details.",
    );
    expect(
      openCodeSmokeTestFailure({
        stdout: '{"type":"error","error":{"name":"ProviderAuthError"}}',
        stderr: "",
        exitCode: 1,
      }),
    ).toBe("ProviderAuthError");
  });

  it("falls back to stderr on a crash and flags an empty reply", () => {
    expect(openCodeSmokeTestFailure({ stdout: "", stderr: "boom\n", exitCode: 3 })).toBe("boom");
    expect(openCodeSmokeTestFailure({ stdout: "", stderr: "", exitCode: 3 })).toBe(
      "OpenCode exited with code 3.",
    );
    expect(
      openCodeSmokeTestFailure({
        stdout: '{"type":"step_finish","part":{}}\nnot json',
        stderr: "",
        exitCode: 0,
      }),
    ).toBe("OpenCode replied with an empty message.");
  });
});

describe("smoke test output tail", () => {
  it("keeps short output whole", () => {
    expect(lastLines("  one line  ")).toBe("one line");
  });

  it("starts a long tail at a line, never mid-word", () => {
    const tail = lastLines(`${"x".repeat(50)} first line\nsecond line\nthird line`, 30);
    expect(tail).toBe("…second line\nthird line");
  });

  it("starts a one-line tail at a word (the Codex alert read 'rect API key provided')", () => {
    const line = `ERROR: unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac****fvMA.`;
    const tail = lastLines(line, 60);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail).not.toMatch(/^…\S*rect\b/);
    expect(line.endsWith(tail.slice(1))).toBe(true);
    expect(tail.slice(1).split(" ")[0]).toMatch(/^[A-Za-z]/);
  });
});
