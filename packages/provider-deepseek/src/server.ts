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
  deepSeekClaudeSettings,
  deepSeekFailureText,
  makeDeepSeekClaudeAdapter,
  type DeepSeekClaudeAdapterFactory,
  type DeepSeekClaudeAdapterFactoryInput,
  type DeepSeekClaudeAdapterOptions,
} from "./server/adapter.ts";
export {
  DeepSeekEngineHost,
  makeDeepSeekEngineAdapter,
  type DeepSeekEngineAdapterInput,
  type DeepSeekEngineHostService,
} from "./server/engineAdapter.ts";
export {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_AUTH_TOKEN_ENV,
  makeDeepSeekEnvironment,
} from "./server/environment.ts";
export {
  dshImageTooLargeText,
  makeDeepSeekDshAdapter,
  translateDshFailure,
  type DeepSeekDshAdapterOptions,
} from "./server/dshAdapter.ts";
export { resolveDshRuntime, resolveDshSkillDirs, type DshRuntime } from "./server/dshRuntime.ts";
export {
  appendDshLedgerLines,
  decodeDshSessionFrames,
  deepSeekUsageFormat,
  deepSeekUsageReader,
  dshSessionFilePath,
  dshSessionsDir,
  dshStepToTranscriptLine,
  dshUsageDir,
  findDshDescendantSessions,
  parseDeepSeekLine,
  parseDeepSeekRecord,
  parseDshAssistantStep,
  parseDshSessionHeader,
  readDshSessionBytes,
  readLedgerLastSeq,
  type DeepSeekUsageReaderEnv,
  type DshAssistantStep,
  type DshFrameRead,
} from "./server/usage.ts";
export {
  DEEPSEEK_TEXTGEN_EFFORT,
  makeDeepSeekTextGeneration,
  withLowEffortWhenAbsent,
  type DeepSeekTextGenerationFactory,
} from "./server/textGeneration.ts";
export {
  DEEPSEEK_BALANCE_CACHE_MS,
  DEEPSEEK_BALANCE_RETRY_AFTER_FAILURE_MS,
  DEEPSEEK_BALANCE_TIMEOUT_MS,
  DEEPSEEK_BALANCE_URL,
  DEEPSEEK_BALANCE_URL_ENV,
  deepSeekBalanceEndpoint,
  makeDeepSeekBalanceReader,
  parseDeepSeekBalance,
  type DeepSeekBalanceAmounts,
  type DeepSeekBalanceFailureReason,
  type DeepSeekBalanceRead,
  type DeepSeekBalanceReader,
  type DeepSeekBalanceReaderOptions,
} from "./server/balance.ts";
