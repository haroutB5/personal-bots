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

import { DEEPSEEK_FLASH_MODEL, type DeepSeekSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import { dedupeEnvironmentNames } from "../environmentNames.ts";
import { resolveDeepSeekEngine } from "./DeepSeekEngine.ts";

export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
export const DEEPSEEK_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const DEEPSEEK_MODEL_ENV = "ANTHROPIC_MODEL";

/** Flash with the runtime's 1M-context rendering (the catalog's `1m` suffix). */
export const DEEPSEEK_FLASH_1M_MODEL = `${DEEPSEEK_FLASH_MODEL}[1m]`;

/**
 * DeepSeek's recommended auto-compact window for Flash's 1M context, from
 * their Claude Code guide (786432 = 768k, three quarters of the window). The
 * same value is pinned in the session environment below and through the
 * adapter's Claude-shaped `autoCompactWindow` setting, so the two mechanisms
 * cannot disagree.
 */
export const DEEPSEEK_AUTO_COMPACT_WINDOW = "786432";

/**
 * Model pins from DeepSeek's Claude Code guide. The session's own `--model`
 * covers user turns, but runtime-internal calls (subagents, background jobs)
 * name models by alias, and DeepSeek's endpoint maps an unresolved
 * `claude-opus*` id to `deepseek-v4-pro`, billed at the Pro price (about 4.4x
 * Flash). Every alias the guide names is pinned to Flash here, opus included,
 * so no internal call can silently upgrade. These values also replace any
 * ambient machine-level values of the same names.
 *
 * The guide's `CLAUDE_CODE_EFFORT_LEVEL=max` is deliberately not pinned: the
 * app selects effort per session and turn, and a machine-level effort pin
 * would fight that.
 */
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

/**
 * The pinned and the dropped names, lower-cased.
 *
 * Windows resolves environment names case-insensitively, so `anthropic_base_url`
 * is the same variable as `ANTHROPIC_BASE_URL` to the child process. Comparing
 * names exactly would let a mixed-case ambient spelling survive the loop and
 * then sit beside the pinned value, leaving which one wins to the OS. The
 * harness engine already de-duplicates this way; the two must not drift apart.
 */
const DEEPSEEK_PINNED_ENV_NAMES_LOWER: ReadonlySet<string> = new Set(
  Object.keys(DEEPSEEK_PINNED_ENVIRONMENT).map((name) => name.toLowerCase()),
);

const DROPPED_MODEL_ENV_NAMES_LOWER: ReadonlySet<string> = new Set(
  [...DROPPED_MODEL_ENV_NAMES].map((name) => name.toLowerCase()),
);

/**
 * Claude engine only: the CLI's own background traffic.
 *
 * The Claude CLI talks to `api.anthropic.com` even when its model endpoint is
 * DeepSeek's — the requests are tunnelled, so what they carry cannot be
 * inspected, and this engine must never need that host. Both switches are the
 * CLI's own documented way to turn that feedback off. The harness engine has
 * no such traffic and is not given them.
 */
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

/**
 * Names that must never reach a provider subprocess: the secret placeholders
 * the app injects, and the credentials of unrelated providers. Exported so the
 * DeepSeek Harness engine strips exactly the same set.
 */
export const isLeakedSecretName = (name: string): boolean => {
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
 *
 * On the Claude engine it also quiets the CLI's own background traffic (see
 * `CLAUDE_ENGINE_QUIET_ENVIRONMENT`).
 *
 * Names are matched and de-duplicated case-insensitively
 * (`dedupeEnvironmentNames`), the same as the harness engine's own child
 * environment, so a mixed-case ambient spelling cannot shadow a pinned value.
 */
export const makeDeepSeekEnvironment = Effect.fn("makeDeepSeekEnvironment")(function* (
  config: Pick<DeepSeekSettings, "homePath" | "engine">,
  baseEnv: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedHomePath = yield* resolveDeepSeekHomePath(config, baseEnv);
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isLeakedSecretName(name)) continue;
    // The endpoint and every model/compaction input are pinned below; drop
    // ambient overrides so a machine-level `ANTHROPIC_BASE_URL`,
    // `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`,
    // `CLAUDE_CODE_SUBAGENT_MODEL` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
    // cannot reroute the session or its alias-mapped internal calls. The
    // comparison is case-insensitive: on Windows a mixed-case spelling is the
    // same variable.
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
