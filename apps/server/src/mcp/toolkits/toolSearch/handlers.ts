import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { McpSchema } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";
import { ToolSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ToolSearchToolkit, {
  tool_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((current) =>
          McpInvocationContext.requireThreadScope(current, "tool_search"),
        ),
      );
      const exposure = yield* McpToolExposure.McpToolExposure;
      const personalBot = scope.personalBot;
      const filter =
        personalBot === undefined
          ? undefined
          : (toolName: string) =>
              McpToolExposure.isToolListedForPersonalBot(toolName, personalBot, {
                hasDevice: scope.capabilities.has("device"),
                hasPreview: scope.capabilities.has("preview"),
              });
      return { tools: yield* exposure.search(scope.thread.providerSessionId, query, filter) };
    }),
  ),
  tool_call: McpToolAccess.readsAsCaller(({ name, arguments: args }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((current) => McpInvocationContext.requireThreadScope(current, "tool_call")),
      );
      if (name === McpToolExposure.TOOL_SEARCH || name === McpToolExposure.TOOL_CALL) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Cannot call ${name} recursively through ${McpToolExposure.TOOL_CALL}.`,
        });
      }
      const missingCapability = McpToolExposure.missingRequiredCapabilityForTool(
        name,
        scope.capabilities,
      );
      if (missingCapability !== null) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `Tool '${name}' requires the '${missingCapability}' capability.`,
        });
      }
      if (
        scope.personalBot !== undefined &&
        !McpToolExposure.isToolListedForPersonalBot(name, scope.personalBot, {
          hasDevice: scope.capabilities.has("device"),
          hasPreview: scope.capabilities.has("preview"),
        })
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `Tool '${name}' is not available to this bot.`,
        });
      }
      const exposure = yield* McpToolExposure.McpToolExposure;
      const isReadOnlyMode =
        scope.client?.access === "read-only" ||
        scope.client?.narrowedTo?.interactionMode === "plan";
      if (isReadOnlyMode && !exposure.isReadOnly(name)) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `Tool '${name}' is not allowed in read-only or plan mode.`,
        });
      }
      const result = yield* exposure.callTool(name, args ?? {});
      const textParts = result.content
        .filter((item): item is McpSchema.TextContent => item.type === "text")
        .map((item) => item.text);
      const text = textParts.length > 0 ? textParts.join("\n") : undefined;
      return {
        tool: name,
        isError: result.isError === true,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(text !== undefined ? { text } : {}),
      };
    }),
  ),
});
