/** One DeepSeek instance runs on dsh or Claude Code; a kill switch forces Claude Code. */
import * as NodeOS from "node:os";

import type { DeepSeekSettings } from "../settings.ts";

export type DeepSeekEngine = "dsh" | "claude-code";

/** The kill switch: set it to `claude-code` (or `off`) to force the old engine. */
export const DEEPSEEK_ENGINE_ENV = "PERSONAL_DEEPSEEK_ENGINE";

/** Install directory name the pinned runtime lives under, and its version. */
export const DSH_PINNED_VERSION = "0.2.1-rc.3";
export const DSH_RUNTIME_DIR_NAME = `dsh-${DSH_PINNED_VERSION}`;

/** The harness home inside a data root: `<stateDir>/dsh`. */
export const DSH_HOME_DIR_NAME = "dsh";

/** `~/.personal-bots/runtimes/dsh-0.2.1-rc.3` — never inside a release folder. */
export const defaultDshRuntimeDir = (): string =>
  [NodeOS.homedir(), ".personal-bots", "runtimes", DSH_RUNTIME_DIR_NAME].join("/");

/** The dsh entry point, run with hbots' own `node`. */
export const dshRuntimeBinJs = (runtimeDir: string): string =>
  [runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"].join("/");

/** What the provider card says when the runtime is not installed. */
export const DSH_RUNTIME_MISSING_MESSAGE =
  "DeepSeek Harness runtime missing: run scripts/personal/install-dsh";

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
