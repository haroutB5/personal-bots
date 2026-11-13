import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that cannot defer tools themselves. The T3 MCP server then
 * lists only a core set plus `tool_search`, which lists the rest on demand.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * `PB_SECRET_<NAME>` values for a personal bot's thread (see
   * `PersonalSessionAccess`). Read from the secret store when the session is
   * prepared and applied when the provider process starts; never logged.
   */
  readonly personalSecretEnvironment?: Readonly<Record<string, string>>;
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
}

/**
 * Everything a session config adds to the provider process env: the device
 * variables, then the personal secrets. Claude and Codex use this.
 */
export function withProviderSessionEnvironment(
  base: NodeJS.ProcessEnv,
  config:
    | Pick<McpProviderSessionConfig, "agentDeviceEnvironment" | "personalSecretEnvironment">
    | undefined,
): NodeJS.ProcessEnv {
  const withDevice = withAgentDeviceEnvironment(base, config);
  const secrets = config?.personalSecretEnvironment;
  if (!secrets || Object.keys(secrets).length === 0) return withDevice;
  return { ...withDevice, ...secrets };
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const MCP_TOKEN_ENV_NAME = "T3_MCP_TOKEN";

/**
 * The SDK writes `mcpServers` into `--mcp-config` on the CLI command line,
 * which any process of this account can read. The header carries a `${VAR}`
 * placeholder and the token rides in the child env. `PERSONAL_MCP_TOKEN_ON_ARGV=1`
 * restores the old command-line token.
 */
export function claudeMcpAuthorization(
  config: Pick<McpProviderSessionConfig, "authorizationHeader">,
  env: NodeJS.ProcessEnv = process.env,
): { readonly header: string; readonly environment: Readonly<Record<string, string>> } {
  const token = config.authorizationHeader.replace(/^Bearer\s+/i, "");
  if (env.PERSONAL_MCP_TOKEN_ON_ARGV === "1" || token === config.authorizationHeader) {
    return { header: config.authorizationHeader, environment: {} };
  }
  return {
    header: `Bearer \${${MCP_TOKEN_ENV_NAME}}`,
    environment: { [MCP_TOKEN_ENV_NAME]: token },
  };
}
