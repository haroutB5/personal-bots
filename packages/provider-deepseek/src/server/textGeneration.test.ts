import { ProviderInstanceId, type ClaudeSettings, type ModelSelection } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import type { ProviderCatalog } from "@t3tools/provider-core/server/ModelCatalog";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { DeepSeekSettings } from "../settings.ts";
import {
  DEEPSEEK_TEXTGEN_EFFORT,
  makeDeepSeekTextGeneration,
  type DeepSeekTextGenerationFactory,
} from "./textGeneration.ts";

const instanceId = ProviderInstanceId.make("deepseek");
const decodeSettings = Schema.decodeSync(DeepSeekSettings);

const selection = (
  options?: ReadonlyArray<{ readonly id: string; readonly value: string }>,
): ModelSelection => ({
  instanceId,
  model: "deepseek-flash",
  ...(options === undefined ? {} : { options }),
});

const harness = () => {
  const seen: Array<{
    readonly settings: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly selection: ModelSelection;
  }> = [];
  const createBase: DeepSeekTextGenerationFactory = (input) => {
    const base: ProviderTextGeneration = {
      generateCommitMessage: () => Effect.die("not used"),
      generatePrContent: () => Effect.die("not used"),
      generateBranchName: () => Effect.die("not used"),
      generateThreadTitle: (threadInput) => {
        seen.push({
          settings: input.settings,
          environment: input.environment,
          selection: threadInput.modelSelection,
        });
        return Effect.succeed({ title: "Thread" });
      },
      generateReviewGuide: () => Effect.die("not used"),
      generateTranscriptionPostProcessing: () => Effect.die("not used"),
    };
    return Effect.succeed(base);
  };
  return { seen, createBase };
};

const runThreadTitle = (options?: ReadonlyArray<{ readonly id: string; readonly value: string }>) =>
  Effect.gen(function* () {
    const { seen, createBase } = harness();
    const service = yield* makeDeepSeekTextGeneration(
      createBase,
      decodeSettings({}),
      { CLAUDE_CONFIG_DIR: "/tmp/deepseek-env" },
      Effect.succeed<ProviderCatalog | undefined>(undefined),
    );
    yield* service.generateThreadTitle({
      cwd: "/repo",
      message: "a message",
      modelSelection: selection(options),
    });
    return seen[0]!;
  });

describe("makeDeepSeekTextGeneration", () => {
  it.effect("appends effort low when the selection names none", () =>
    Effect.gen(function* () {
      const run = yield* runThreadTitle();
      expect(DEEPSEEK_TEXTGEN_EFFORT).toBe("low");
      expect(run.selection.options).toEqual([{ id: "effort", value: "low" }]);
    }),
  );

  it.effect("keeps a selection that already names an effort", () =>
    Effect.gen(function* () {
      const run = yield* runThreadTitle([{ id: "effort", value: "xhigh" }]);
      expect(run.selection.options).toEqual([{ id: "effort", value: "xhigh" }]);
    }),
  );

  it.effect("hands the base the DeepSeek config dir and the pinned auto-compact window", () =>
    Effect.gen(function* () {
      const run = yield* runThreadTitle();
      expect(run.settings.homePath).toBe("");
      expect(run.settings.autoCompactWindow).toBe("786432");
      expect(run.environment).toEqual({ CLAUDE_CONFIG_DIR: "/tmp/deepseek-env" });
    }),
  );
});
