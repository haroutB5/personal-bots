import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";

const ToolSearchTool = Tool.make(McpToolExposure.TOOL_SEARCH, {
  description:
    "Load tools you do not have yet, then call them by name (or via tool_call if your client does not refresh tool lists). Search by name or purpose: preview_* browser, computer_* desktop, *_routine schedules, connection_* and create_app*, use_login/request_secret/secret_request, usage_status, device_*, html_preview/html_render, threads (t3_thread_*), projects (t3_project_*), worktrees, schedule_task, pull requests, attachments, environment links. Exact names work too.",
  parameters: Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(500)) }),
  success: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        inputSchema: Schema.Unknown,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolExposure.McpToolExposure],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ToolCallTool = Tool.make(McpToolExposure.TOOL_CALL, {
  description:
    "Call any tool discovered with tool_search by name and JSON arguments. Use this fallback when your client cannot invoke newly discovered tools directly.",
  parameters: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.Struct({
    tool: Schema.String,
    isError: Schema.Boolean,
    structuredContent: Schema.optional(Schema.Unknown),
    text: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolExposure.McpToolExposure],
});

export const ToolSearchToolkit = Toolkit.make(ToolSearchTool, ToolCallTool);
