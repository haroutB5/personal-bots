/**
 * DeepSeek environment — fixed endpoint, server-side key, isolated config home.
 *
 * DeepSeek sessions reuse the Claude Agent SDK binary, pointed at DeepSeek's
 * Anthropic-compatible endpoint. The key (`ANTHROPIC_AUTH_TOKEN`) comes from
 * the instance's sensitive environment entry — never from driver settings —
 * and the endpoint is fixed, so there is nothing to misconfigure. The config
 * home is isolated per instance so DeepSeek never reads real `~/.claude`
 * state or Anthropic account credentials.
 *
 * Secret hygiene: `PB_SECRET_*` placeholders and unrelated provider tokens
 * are stripped before the SDK spawns, so a DeepSeek request carries only its
 * own credential.
 *
 * @module provider/Drivers/DeepSeekEnvironment
 */
import * as NodeOS from "node:os";

import type { DeepSeekSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const DEEPSEEK_MODEL_ENV = "ANTHROPIC_MODEL";

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

const isLeakedSecretName = (name: string): boolean => {
  if (name.startsWith("PB_SECRET_")) return true;
  return UNRELATED_TOKEN_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
};

/**
 * Resolve the isolated DeepSeek config directory: the instance's `homePath`,
 * then an inherited `CLAUDE_CONFIG_DIR` (per-instance override), then a
 * DeepSeek-specific default under `~` — never the real `~/.claude`.
 */
export const resolveDeepSeekHomePath = Effect.fn("resolveDeepSeekHomePath")(function* (
  config: Pick<DeepSeekSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(NodeOS.homedir(), ".claude-t3-deepseek"));
});

/**
 * Build the SDK subprocess environment for a DeepSeek session: the merged
 * instance environment, minus leaked secrets and unrelated provider tokens,
 * plus the fixed DeepSeek endpoint, the instance's auth token, and the
 * isolated config dir. Missing token yields an empty env marker the driver
 * turns into a useful "not configured" snapshot instead of spawning.
 */
export const makeDeepSeekEnvironment = Effect.fn("makeDeepSeekEnvironment")(function* (
  config: Pick<DeepSeekSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedHomePath = yield* resolveDeepSeekHomePath(config, baseEnv);
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isLeakedSecretName(name)) continue;
    // The endpoint and model are fixed below; drop ambient overrides so a
    // machine-level `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` cannot reroute us.
    if (name === "ANTHROPIC_BASE_URL" || name === DEEPSEEK_MODEL_ENV) continue;
    next[name] = value;
  }
  const token = baseEnv[DEEPSEEK_AUTH_TOKEN_ENV]?.trim() ?? "";
  if (token.length > 0) {
    next[DEEPSEEK_AUTH_TOKEN_ENV] = baseEnv[DEEPSEEK_AUTH_TOKEN_ENV];
  }
  next.ANTHROPIC_BASE_URL = DEEPSEEK_ANTHROPIC_BASE_URL;
  next.CLAUDE_CONFIG_DIR = resolvedHomePath;
  return next;
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
