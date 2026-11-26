import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import { useMemo } from "react";

import type { PersonalClient } from "../client.ts";

/** External MCP servers (including self-hosted Executor) managed for bots. */
export function createPersonalExternalMcpClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const personalExternalMcpList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-external-mcp:list",
    tag: WS_METHODS.personalExternalMcpList,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  });

  const refreshExternalMcp = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalExternalMcpList>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(personalExternalMcpList({ environmentId: target.environmentId, input: {} })),
    );

  const personalExternalMcpCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-external-mcp:create",
    tag: WS_METHODS.personalExternalMcpCreate,
    onSuccess: refreshExternalMcp,
  });

  const personalExternalMcpUpdate = createEnvironmentRpcCommand(runtime, {
    label: "personal-external-mcp:update",
    tag: WS_METHODS.personalExternalMcpUpdate,
    onSuccess: refreshExternalMcp,
  });

  const personalExternalMcpDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-external-mcp:delete",
    tag: WS_METHODS.personalExternalMcpDelete,
    onSuccess: refreshExternalMcp,
  });

  const personalExternalMcpTestConnection = createEnvironmentRpcCommand(runtime, {
    label: "personal-external-mcp:test-connection",
    tag: WS_METHODS.personalExternalMcpTestConnection,
  });

  function usePersonalExternalMcpServers(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : personalExternalMcpList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  return {
    personalExternalMcpList,
    personalExternalMcpCreate,
    personalExternalMcpUpdate,
    personalExternalMcpDelete,
    personalExternalMcpTestConnection,
    usePersonalExternalMcpServers,
  };
}

export type PersonalExternalMcpClient = ReturnType<typeof createPersonalExternalMcpClient>;
