import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";

export const USAGE_REFRESH_FAILED_MESSAGE = "Couldn't refresh usage";

export interface UsageRefreshRequest {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly refreshUsage: true };
}

/** The refresh command, narrowed to the request and result the sheet uses. */
export type SendUsageRefresh = (
  request: UsageRefreshRequest,
) => Promise<AtomCommandResult<unknown, unknown>>;

/**
 * Ask the server to re-read subscription limits. `refreshUsage` is the flag
 * that makes the server probe each provider; `fresh` only invalidates caches
 * when a cwd or the model list is refreshed, so a refresh built on it returns
 * the same cached reading. Returns the message to show on failure, or null.
 */
export async function sendUsageRefresh(
  send: SendUsageRefresh,
  environmentId: EnvironmentId,
): Promise<string | null> {
  const result = await send({ environmentId, input: { refreshUsage: true } });
  return commandFailureMessage(result, USAGE_REFRESH_FAILED_MESSAGE);
}
