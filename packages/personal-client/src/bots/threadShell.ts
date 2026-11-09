import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";

/** The latest turn of a chat as the personal RPCs report it. */
export type OrchestrationLatestTurn = NonNullable<OrchestrationThreadShell["latestTurn"]>;

/**
 * A bot chat's thread shell: the wire shell the personal RPCs send, scoped to
 * the environment it came from.
 */
export type EnvironmentThreadShell = OrchestrationThreadShell & {
  readonly environmentId: EnvironmentId;
};
