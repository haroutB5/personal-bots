import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { McpSchema } from "effect/ai";

import type { McpCapability, McpPersonalBotScope } from "./McpInvocationContext.ts";

export const TOOL_SEARCH = "tool_search";
export const TOOL_CALL = "tool_call";
export const ECO_HANDOFF_TOOL_NAME = "eco_handoff";

/** What a deferring desktop client lists before it searches. Pi's extension declares the same three. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  TOOL_SEARCH,
]);

/** What a deferring personal-bot session lists before it searches. */
export const PERSONAL_BOT_DIRECT_TOOLS: ReadonlySet<string> = new Set([
  TOOL_SEARCH,
  TOOL_CALL,
  "search_memory",
  "save_memory",
  "forget_memory",
  "search_web",
  "read_pages",
  "list_bots",
  "delegate_task",
  "steer_task",
  "list_tasks",
  "update_work_record",
]);

/**
 * T3 desktop IDE tools that personal bots never call. Hiding them from personal-bot
 * `tools/list`, `tool_search`, and `tool_call` keeps the advertised MCP schema set compact
 * and prevents member bots from discovering or invoking desktop-only tools.
 */
const PERSONAL_BOT_HIDDEN_DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "task_status",
  "task_cancel",
  "t3_workflow_stop",
  "t3_background_wait",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  "create_threads",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_search",
  "t3_thread_configure",
  "t3_thread_transfer",
  "t3_thread_organize",
  "t3_thread_launch",
  "t3_pending_request",
  "t3_queue",
  "t3_attachment_prepare_upload",
  "t3_attachment_discard",
  "t3_thread_send_attachments",
  "t3_project_list",
  "t3_project_read",
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_environment_read",
  "t3_environment_preferences_update",
  "t3_environment_links",
  "t3_environment_link",
  "t3_environment_unlink",
  "t3_preview_list",
  "t3_preview_close",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "t3_worktree_list",
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "unlink_pull_requests",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "read_pull_request_guide",
]);

const TEAM_LEAD_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
  "create_bot",
  "update_bot",
  "remove_bot",
  "update_project",
]);

const GROUP_CHAT_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set(["call_vote", "cast_vote"]);

const DEVICE_MCP_TOOLS: ReadonlySet<string> = new Set([
  "device_list",
  "device_open",
  "device_close",
  "device_screenshot",
]);

/**
 * Returns the capability missing from `capabilities` when `toolName` requires a
 * thread capability (`preview` or `device`), or `null` when allowed.
 */
export const missingRequiredCapabilityForTool = (
  toolName: string,
  capabilities: ReadonlySet<McpCapability>,
): McpCapability | null => {
  if (DEVICE_MCP_TOOLS.has(toolName) || toolName.startsWith("device_")) {
    return capabilities.has("device") ? null : "device";
  }
  if (
    toolName.startsWith("preview_") ||
    toolName === "t3_preview_list" ||
    toolName === "t3_preview_close"
  ) {
    return capabilities.has("preview") ? null : "preview";
  }
  return null;
};

export const isToolListedForPersonalBot = (
  toolName: string,
  bot: McpPersonalBotScope,
  options?: { readonly hasDevice?: boolean; readonly hasPreview?: boolean },
): boolean => {
  if (toolName === ECO_HANDOFF_TOOL_NAME) return false;
  if (PERSONAL_BOT_HIDDEN_DESKTOP_TOOLS.has(toolName)) return false;
  if (options?.hasDevice !== true && DEVICE_MCP_TOOLS.has(toolName)) return false;
  if (options?.hasPreview === false && toolName.startsWith("preview_")) return false;
  if (!bot.isLead && TEAM_LEAD_ONLY_MCP_TOOLS.has(toolName)) return false;
  if (!bot.isGroup && GROUP_CHAT_ONLY_MCP_TOOLS.has(toolName)) return false;
  return true;
};

export const isPersonalBotDirectTool = (toolName: string, bot: McpPersonalBotScope): boolean =>
  PERSONAL_BOT_DIRECT_TOOLS.has(toolName) ||
  (bot.isGroup && GROUP_CHAT_ONLY_MCP_TOOLS.has(toolName)) ||
  (bot.isLead && toolName === "update_project");

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
export const MAX_SESSIONS = 1024;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query and lists them to the session from now on. */
    readonly search: (
      providerSessionId: string,
      query: string,
      filter?: (toolName: string) => boolean,
    ) => Effect.Effect<ReadonlyArray<ListedTool>>;
    readonly isListed: (
      providerSessionId: string,
      tool: string,
      personalBot?: McpPersonalBotScope,
    ) => boolean;
    /** Whether the registered tool declares `readOnlyHint: true`. */
    readonly isReadOnly: (name: string) => boolean;
    /** Dispatches a deferred tool call through the server under the active MCP client context. */
    readonly callTool: (
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<McpSchema.CallToolResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/McpToolExposure") {}

const score = (tool: ListedTool, terms: ReadonlyArray<string>) => {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term === name) total += 100;
    else if (name.includes(term)) total += 3;
    else if (description.includes(term)) total += 1;
  }
  return total;
};

export interface McpToolExposureOptions {
  readonly maxSessions?: number | undefined;
  readonly isReadOnly?: ((name: string) => boolean) | undefined;
}

export const make = (
  tools: () => ReadonlyArray<ListedTool>,
  announceListChanged: () => Effect.Effect<void>,
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<McpSchema.CallToolResult, OrchestratorMcpFailure>,
  options?: McpToolExposureOptions,
) => {
  const maxSessions = options?.maxSessions ?? MAX_SESSIONS;
  const isReadOnly = options?.isReadOnly ?? (() => false);
  const loaded = new Map<string, Set<string>>();
  const load = (providerSessionId: string, names: ReadonlyArray<string>) => {
    const listed = loaded.get(providerSessionId) ?? new Set<string>();
    loaded.delete(providerSessionId);
    loaded.set(providerSessionId, listed);
    for (const name of names) listed.add(name);
    for (const oldest of loaded.keys()) {
      if (loaded.size <= maxSessions) break;
      loaded.delete(oldest);
    }
  };
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query, filter) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const found = tools()
        .filter(
          (tool) =>
            tool.name !== TOOL_SEARCH &&
            tool.name !== TOOL_CALL &&
            tool.name !== ECO_HANDOFF_TOOL_NAME &&
            (filter === undefined || filter(tool.name)),
        )
        .map((tool) => ({ tool, score: score(tool, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((match) => match.tool);
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        yield* announceListChanged();
      }
      return found;
    }),
    isListed: (providerSessionId, tool, personalBot) => {
      const listed = loaded.get(providerSessionId);
      if (listed !== undefined) {
        // Refresh LRU recency so active sessions are not evicted by burst traffic.
        loaded.delete(providerSessionId);
        loaded.set(providerSessionId, listed);
      }
      return (
        (personalBot === undefined
          ? DIRECT_TOOLS.has(tool)
          : isPersonalBotDirectTool(tool, personalBot)) || listed?.has(tool) === true
      );
    },
    isReadOnly,
    callTool,
  });
};
