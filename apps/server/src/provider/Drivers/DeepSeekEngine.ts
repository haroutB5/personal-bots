/**
 * Which engine a DeepSeek instance runs its bots on.
 *
 * One DeepSeek provider, two engines: the DeepSeek Harness (`dsh`) over ACP,
 * or the Claude Agent SDK against DeepSeek's Anthropic-compatible endpoint.
 * The instance setting picks, and a kill switch forces the old engine for
 * every instance at once, so a bad dsh build is dropped with one environment
 * variable and the usual idle restart.
 *
 * @module provider/Drivers/DeepSeekEngine
 */
import type { DeepSeekEngine, DeepSeekSettings } from "@t3tools/contracts";

/** The kill switch: set it to `claude-code` (or `off`) to force the old engine. */
export const DEEPSEEK_ENGINE_ENV = "PERSONAL_DEEPSEEK_ENGINE";

/** Install directory name the pinned runtime lives under, and its version. */
export const DSH_PINNED_VERSION = "0.2.0-rc.2";
export const DSH_RUNTIME_DIR_NAME = `dsh-${DSH_PINNED_VERSION}`;

/** The harness home inside a data root: `<stateDir>/dsh`. */
export const DSH_HOME_DIR_NAME = "dsh";

const CLAUDE_CODE_VALUES = new Set(["claude-code", "off", "0", "false", "no"]);

/**
 * The engine an instance actually uses: the kill switch wins over the
 * setting. Read when a driver instance is built, so a change lands with the
 * idle restart, exactly like the other `PERSONAL_*` switches.
 */
export function resolveDeepSeekEngine(
  settings: Pick<DeepSeekSettings, "engine">,
  environment: NodeJS.ProcessEnv = process.env,
): DeepSeekEngine {
  const forced = environment[DEEPSEEK_ENGINE_ENV]?.trim().toLowerCase() ?? "";
  if (CLAUDE_CODE_VALUES.has(forced)) return "claude-code";
  return settings.engine;
}
