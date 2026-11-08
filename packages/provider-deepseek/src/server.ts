/**
 * DeepSeek's server surface.
 *
 * @module provider-deepseek/server
 */
export { DeepSeekDriver, type DeepSeekDriverEnv } from "./server/driver.ts";
export { DeepSeekSettings } from "./settings.ts";
export { dedupeEnvironmentNames } from "./server/environmentNames.ts";
export {
  canonicalizeDeepSeekModelId,
  DEEPSEEK_FLASH_MODEL,
  resolveDeepSeekModelCatalog,
} from "./server/catalog.ts";
export { resolveDeepSeekEngine, type DeepSeekEngine } from "./server/engine.ts";
export {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_AUTH_TOKEN_ENV,
  makeDeepSeekEnvironment,
} from "./server/environment.ts";
