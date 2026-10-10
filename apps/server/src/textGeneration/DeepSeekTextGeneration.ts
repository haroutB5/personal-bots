/**
 * DeepSeekTextGeneration — background text jobs on DeepSeek Flash.
 *
 * Direct reuse of the Claude text-generation runtime (`makeClaudeTextGeneration`)
 * against the DeepSeek endpoint: same `claude -p` JSON flow, DeepSeek catalog
 * and DeepSeek subprocess environment. No copied CLI implementation.
 *
 * Selection policy: an explicit DeepSeek selection is used as-is (bot turns
 * default to high from the manifest); background jobs that name no effort run
 * at low, where supported. There is no Claude fallback — a failed Flash job
 * fails with DeepSeek's own error.
 *
 * @module textGeneration/DeepSeekTextGeneration
 */
import type { DeepSeekSettings, ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  BUNDLED_DEEPSEEK_MODEL_CATALOG,
  DEEPSEEK_FLASH_SLUG,
  type DeepSeekModelCatalog,
} from "../provider/DeepSeekModelCatalog.ts";

const DEEPSEEK_TEXTGEN_EFFORT = "low";

const withLowEffortWhenAbsent = (selection: ModelSelection): ModelSelection => {
  const hasEffort = (selection.options ?? []).some((option) => option.id === "effort");
  if (hasEffort) return selection;
  return {
    ...selection,
    model: selection.model || DEEPSEEK_FLASH_SLUG,
    options: [...(selection.options ?? []), { id: "effort", value: DEEPSEEK_TEXTGEN_EFFORT }],
  };
};

export const makeDeepSeekTextGeneration = Effect.fn("makeDeepSeekTextGeneration")(function* (
  settings: DeepSeekSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<DeepSeekModelCatalog> = Effect.succeed(
    BUNDLED_DEEPSEEK_MODEL_CATALOG,
  ),
) {
  const inner = yield* makeClaudeTextGeneration(
    {
      enabled: settings.enabled,
      binaryPath: settings.binaryPath,
      homePath: settings.homePath,
      customModels: [],
      launchArgs: "",
      autoCompactWindow: "",
    },
    environment,
    modelCatalog as unknown as Parameters<typeof makeClaudeTextGeneration>[2],
  );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) =>
    inner.generateCommitMessage({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) =>
    inner.generatePrContent({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) =>
    inner.generateBranchName({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) =>
    inner.generateThreadTitle({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateStructured: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateStructured"]
  > = (input) => inner.generateStructured!(input);

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateStructured,
  } satisfies TextGeneration.TextGeneration["Service"];
});
