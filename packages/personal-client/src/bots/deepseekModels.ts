/**
 * The DeepSeek names the bots surfaces read. They follow the DeepSeek provider
 * contract (D1), which is not in `@t3tools/contracts` yet.
 */
export const DEEPSEEK_AGENT_MODE_OPTION_ID = "agentMode";

const DEEPSEEK_MODEL_IDS: ReadonlySet<string> = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "vision-exp",
]);

/** Whether a model id is one the DeepSeek Harness runs, ignoring case and a `[1m]` suffix. */
export function isDeepSeekModelId(model: string | null | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return DEEPSEEK_MODEL_IDS.has(normalized.replace(/\[[^\]]*\]$/, ""));
}
