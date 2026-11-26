import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { mcpRules as openCodeMcpRules } from "@t3tools/provider-opencode/server/v2/adapter";
import { acpMcpContext } from "@t3tools/provider-acp/server/adapter";

const makeSessionWithExtra = (): McpProviderSession.McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "ps-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer thread-mcp-secret-token",
  browserToolsAvailable: true,
  extraMcpServers: [
    {
      name: "ext-executor",
      url: "http://127.0.0.1:43123/api/personal/external-mcp/srv-1/mcp",
      authorizationHeader: "Bearer thread-mcp-secret-token",
    },
  ],
});

describe("extraMcpServers provider adapter wiring", () => {
  it("ClaudeAdapterV2 injects extraMcpServers with ${T3_MCP_TOKEN} placeholder and omits them in readOnlySandbox", () => {
    const session = makeSessionWithExtra();
    const full = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: session,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });
    expect(full.allowedTools).toContain("mcp__t3-code__*");
    expect(full.allowedTools).toContain("mcp__ext-executor__*");
    expect(full.mcpServers).toEqual({
      "t3-code": {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: { Authorization: "Bearer ${T3_MCP_TOKEN}" },
        timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
      },
      "ext-executor": {
        type: "http",
        url: "http://127.0.0.1:43123/api/personal/external-mcp/srv-1/mcp",
        headers: { Authorization: "Bearer ${T3_MCP_TOKEN}" },
        timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
      },
    });

    const readOnly = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: session,
      readOnlySandbox: true,
    });
    expect(readOnly.allowedTools).not.toContain("mcp__ext-executor__*");
    expect(readOnly.mcpServers).not.toHaveProperty("ext-executor");
  });

  it("CodexAdapterV2 adds mcp_servers.<name> entries alongside mcp_servers.t3-code", () => {
    const session = makeSessionWithExtra();
    const params = CodexAdapterV2.codexThreadRuntimeParams({
      threadId: session.threadId,
      mcpSession: session,
    });
    expect(params.config["mcp_servers.t3-code"]).toBeDefined();
    expect(params.config["mcp_servers.ext-executor"]).toEqual({
      url: "http://127.0.0.1:43123/api/personal/external-mcp/srv-1/mcp",
      tool_timeout_sec: 65 * 60,
      http_headers: { Authorization: "Bearer thread-mcp-secret-token" },
    });
  });

  it("provider-opencode mcpRules allows <name>_* for extra MCP servers", () => {
    const rules = openCodeMcpRules("t3-code-thread-1", ["ext-executor", "ext-docs"]);
    expect(rules).toEqual([
      { action: "t3-code-*", resource: "*", effect: "deny" },
      { action: "t3-code-thread-1_*", resource: "*", effect: "allow" },
      { action: "ext-executor_*", resource: "*", effect: "allow" },
      { action: "ext-docs_*", resource: "*", effect: "allow" },
    ]);
  });

  it("provider-acp acpMcpContext appends extraMcpServers to httpServers when mcpOverHttp is true", () => {
    const session = makeSessionWithExtra();
    const self = { command: "/usr/bin/node", args: [], entrypoint: undefined };

    const withHttp = acpMcpContext(session, self, true, false);
    expect(withHttp.httpServers).toEqual([
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1:43123/mcp",
        headers: [{ name: "Authorization", value: "Bearer thread-mcp-secret-token" }],
      },
      {
        type: "http",
        name: "ext-executor",
        url: "http://127.0.0.1:43123/api/personal/external-mcp/srv-1/mcp",
        headers: [{ name: "Authorization", value: "Bearer thread-mcp-secret-token" }],
      },
    ]);

    const withoutHttp = acpMcpContext(session, self, false, false);
    expect(withoutHttp.httpServers).toEqual([]);
  });
});
