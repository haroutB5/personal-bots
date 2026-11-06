import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type {
  McpInvocationScope,
  McpThreadInvocationScope,
} from "../../mcp/McpInvocationContext.ts";

/** Test fixture: a thread-bound MCP scope from the flat v1 shape. */
export const mcpThreadScope = (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: McpInvocationScope["capabilities"];
  readonly issuedAt: number;
}): McpThreadInvocationScope => ({
  environmentId: input.environmentId,
  capabilities: input.capabilities,
  issuedAt: input.issuedAt,
  requestNamespace: "test",
  thread: {
    threadId: input.threadId,
    providerSessionId: input.providerSessionId,
    providerInstanceId: input.providerInstanceId,
  },
  client: undefined,
});
