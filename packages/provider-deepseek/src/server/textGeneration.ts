/**
 * Background text jobs on DeepSeek Flash: DeepSeek settings and low effort
 * when a selection names none, through the app's Claude runtime.
 * @module provider-deepseek/server/textGeneration
 */
import type { ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderCatalog } from "@t3tools/provider-core/server/ModelCatalog";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import type { DeepSeekSettings } from "../settings.ts";
import { deepSeekClaudeSettings } from "./adapter.ts";
import { DEEPSEEK_FLASH_MODEL } from "./catalog.ts";

export const DEEPSEEK_TEXTGEN_EFFORT = "low";

export const withLowEffortWhenAbsent = (selection: ModelSelection): ModelSelection => {
  const hasEffort = (selection.options ?? []).some((option) => option.id === "effort");
  if (hasEffort) return selection;
  return {
    ...selection,
    model: selection.model || DEEPSEEK_FLASH_MODEL,
    options: [...(selection.options ?? []), { id: "effort", value: DEEPSEEK_TEXTGEN_EFFORT }],
  };
};

/** What the app binds: its Claude text-generation runtime with its services. */
export type DeepSeekTextGenerationFactory = (input: {
  readonly settings: ReturnType<typeof deepSeekClaudeSettings>;
  readonly environment: NodeJS.ProcessEnv;
  readonly providerCatalog: Effect.Effect<ProviderCatalog | undefined>;
}) => Effect.Effect<ProviderTextGeneration, never, never>;

export const makeDeepSeekTextGeneration = Effect.fn("makeDeepSeekTextGeneration")(function* (
  createBase: DeepSeekTextGenerationFactory,
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
  providerCatalog: Effect.Effect<ProviderCatalog | undefined>,
) {
  const inner = yield* createBase({
    settings: deepSeekClaudeSettings(settings),
    environment,
    providerCatalog,
  });

  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = (input) =>
    inner.generateCommitMessage({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generatePrContent: ProviderTextGeneration["generatePrContent"] = (input) =>
    inner.generatePrContent({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateBranchName: ProviderTextGeneration["generateBranchName"] = (input) =>
    inner.generateBranchName({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = (input) =>
    inner.generateThreadTitle({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = (input) =>
    inner.generateReviewGuide({
      ...input,
      modelSelection: withLowEffortWhenAbsent(input.modelSelection),
    });
  const generateTranscriptionPostProcessing: ProviderTextGeneration["generateTranscriptionPostProcessing"] =
    (input) => inner.generateTranscriptionPostProcessing(input);

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
    generateTranscriptionPostProcessing,
  } satisfies ProviderTextGeneration;
});
