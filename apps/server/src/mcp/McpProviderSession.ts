import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * `PB_SECRET_<NAME>` values for a personal bot's thread (see
   * `PersonalSessionAccess`). Read from the secret store when the session is
   * prepared and applied when the provider process starts; never logged.
   */
  readonly personalSecretEnvironment?: Readonly<Record<string, string>>;
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

/** Provider env with the device variables applied over `base`, or `base` untouched. */
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

/** Environment variable that carries a Claude CLI's MCP bearer token (see {@link claudeMcpAuthorization}). */
export const MCP_TOKEN_ENV_NAME = "T3_MCP_TOKEN";

/**
 * How a Claude CLI session presents the session's bearer token to the t3-code
 * MCP server.
 *
 * The SDK writes the whole `mcpServers` option into `--mcp-config '{...}'` on
 * the CLI's command line, and any process of this account can read a command
 * line (Get-CimInstance Win32_Process). So the header carries the placeholder
 * `Bearer ${T3_MCP_TOKEN}` and the token itself goes only in the child's
 * environment; the CLI expands `${VAR}` in MCP headers from its own env
 * (checked with a real Sonnet 5.5 turn: every MCP request authenticated and the
 * command line held only the placeholder).
 *
 * Kill switch: `PERSONAL_MCP_TOKEN_ON_ARGV=1` puts the token back on the command
 * line, the behaviour before 1.57.
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

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
