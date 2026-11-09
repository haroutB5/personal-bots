/** DeepSeek's fixed endpoint, server-side key, isolated home, and secret stripping. */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { DeepSeekSettings } from "../settings.ts";
import { DEEPSEEK_FLASH_MODEL } from "./catalog.ts";
import { dedupeEnvironmentNames } from "./environmentNames.ts";
import { resolveDeepSeekEngine } from "./engine.ts";

export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const DEEPSEEK_MODEL_ENV = "ANTHROPIC_MODEL";

/** Flash with the runtime's 1M-context rendering (the catalog's `1m` suffix). */
export const DEEPSEEK_FLASH_1M_MODEL = `${DEEPSEEK_FLASH_MODEL}[1m]`;

// 786432 is three quarters of Flash's 1M window, pinned here and in the adapter.
export const DEEPSEEK_AUTO_COMPACT_WINDOW = "786432";

// DeepSeek bills an unresolved claude-opus id as Pro, so every alias is pinned to
// Flash. Effort is not pinned: the app selects it per session and turn.
const DEEPSEEK_PINNED_ENVIRONMENT: Readonly<Record<string, string>> = {
  [DEEPSEEK_MODEL_ENV]: DEEPSEEK_FLASH_1M_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_FLASH_1M_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_FLASH_1M_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_FLASH_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_FLASH_MODEL,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: DEEPSEEK_AUTO_COMPACT_WINDOW,
};

/**
 * Ambient model-selecting names with no pinned replacement: the CLI's legacy
 * small/fast model and its bare default-model input. The pins above already
 * carry those roles, so dropping the ambient values only removes ways for a
 * machine-level variable to route a DeepSeek call somewhere else.
 */
const DROPPED_MODEL_ENV_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
]);

// Windows compares names case-insensitively, so the pins and drops are matched lower-cased.
const DEEPSEEK_PINNED_ENV_NAMES_LOWER: ReadonlySet<string> = new Set(
  Object.keys(DEEPSEEK_PINNED_ENVIRONMENT).map((name) => name.toLowerCase()),
);

const DROPPED_MODEL_ENV_NAMES_LOWER: ReadonlySet<string> = new Set(
  [...DROPPED_MODEL_ENV_NAMES].map((name) => name.toLowerCase()),
);

// The Claude CLI still opens api.anthropic.com; both switches are its documented way
// to stop that traffic, and only the Claude engine gets them.
const CLAUDE_ENGINE_QUIET_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
};

const UNRELATED_TOKEN_PREFIXES = [
  "OPENAI_",
  "CODEX_",
  "GROK_",
  "XAI_",
  "CURSOR_",
  "GEMINI_",
  "GOOGLE_",
  "VERTEX_",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLIPROXY_",
];

/** Secret placeholders and unrelated provider credentials that must never reach the child. */
export const isLeakedSecretName = (name: string): boolean => {
  if (name.startsWith("PB_SECRET_")) return true;
  return UNRELATED_TOKEN_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
};

// The instance homePath, then an inherited CLAUDE_CONFIG_DIR, then ~/.claude-t3-deepseek.
export const resolveDeepSeekHomePath = Effect.fn("resolveDeepSeekHomePath")(function* (
  config: Pick<DeepSeekSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, NodeOS.homedir()));
  }
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(NodeOS.homedir(), ".claude-t3-deepseek"));
});

// The merged instance environment minus leaked secrets, plus the fixed endpoint,
// the instance token, the isolated config dir, and the Claude engine's quiet switches.
export const makeDeepSeekEnvironment = Effect.fn("makeDeepSeekEnvironment")(function* (
  config: Pick<DeepSeekSettings, "homePath" | "engine">,
  baseEnv: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedHomePath = yield* resolveDeepSeekHomePath(config, baseEnv);
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isLeakedSecretName(name)) continue;
    // The endpoint and every model/compaction input are pinned below, so ambient
    // values must not survive beside them.
    const lowerName = name.toLowerCase();
    if (lowerName === "anthropic_base_url") continue;
    if (DEEPSEEK_PINNED_ENV_NAMES_LOWER.has(lowerName)) continue;
    if (DROPPED_MODEL_ENV_NAMES_LOWER.has(lowerName)) continue;
    next[name] = value;
  }
  const token = baseEnv[DEEPSEEK_AUTH_TOKEN_ENV]?.trim() ?? "";
  if (token.length > 0) {
    next[DEEPSEEK_AUTH_TOKEN_ENV] = baseEnv[DEEPSEEK_AUTH_TOKEN_ENV];
  }
  next.ANTHROPIC_BASE_URL = DEEPSEEK_ANTHROPIC_BASE_URL;
  for (const [name, value] of Object.entries(DEEPSEEK_PINNED_ENVIRONMENT)) {
    next[name] = value;
  }
  next.CLAUDE_CONFIG_DIR = resolvedHomePath;
  if (resolveDeepSeekEngine(config, baseEnv) === "claude-code") {
    for (const [name, value] of Object.entries(CLAUDE_ENGINE_QUIET_ENVIRONMENT)) {
      next[name] = value;
    }
  }
  // One entry per name, case-insensitively: an ambient `Path`/`PATH` pair would
  // otherwise reach the child as two spellings of one variable, and the pinned
  // values set above must be the ones that win.
  return dedupeEnvironmentNames(next);
});

export const makeDeepSeekContinuationGroupKey = Effect.fn("makeDeepSeekContinuationGroupKey")(
  function* (
    config: Pick<DeepSeekSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveDeepSeekHomePath(config, environment);
    return `deepseek:home:${resolvedHomePath}`;
  },
);

export const makeDeepSeekCapabilitiesCacheKey = Effect.fn("makeDeepSeekCapabilitiesCacheKey")(
  function* (
    config: Pick<DeepSeekSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveDeepSeekHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
