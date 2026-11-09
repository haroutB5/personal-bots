/**
 * The engine seam: one DeepSeek instance runs on dsh or Claude Code. The app
 * supplies the two things a package cannot own, the Claude adapter factory and
 * the Performance-tab process registry.
 * @module provider-deepseek/server/engineAdapter
 */
import { type ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { ProviderCatalog } from "@t3tools/provider-core/server/ModelCatalog";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";

import type { DeepSeekSettings } from "../settings.ts";
import { makeDeepSeekClaudeAdapter, type DeepSeekClaudeAdapterFactory } from "./adapter.ts";
import { makeDeepSeekDshAdapter, type DeepSeekDshAdapterOptions } from "./dshAdapter.ts";
import type { DeepSeekEngine } from "./engine.ts";
import type { DeepSeekTextGenerationFactory } from "./textGeneration.ts";

export interface DeepSeekEngineHostService {
  /** The app's `createClaudeAdapterV2`, already bound to its own services. */
  readonly createClaudeAdapter: DeepSeekClaudeAdapterFactory;
  /** The app's Claude text-generation runtime, already bound to its own services. */
  readonly createTextGeneration: DeepSeekTextGenerationFactory;
  readonly registerProcess: (input: {
    readonly threadId: string;
    readonly provider: string;
    readonly pid: number;
  }) => void;
  readonly forgetProcess: (threadId: string, pid?: number) => void;
}

export class DeepSeekEngineHost extends Context.Service<
  DeepSeekEngineHost,
  DeepSeekEngineHostService
>()("@t3tools/provider-deepseek/server/engineAdapter/DeepSeekEngineHost") {}

export interface DeepSeekEngineAdapterInput {
  readonly instanceId: ProviderInstanceId;
  readonly engine: DeepSeekEngine;
  readonly settings: DeepSeekSettings;
  /** The exact child environment DeepSeek's endpoint and pins produced. */
  readonly environment: NodeJS.ProcessEnv;
  readonly providerCatalog: Effect.Effect<ProviderCatalog | undefined>;
  readonly selfInvocation: SelfInvocation;
  readonly displayName?: string;
  readonly accentColor?: string;
  /** Test-only spawn controls for the package's seam test; the driver never sets them. */
  readonly dshTest?: {
    readonly dshHome?: string;
    readonly spawnForTest?: DeepSeekDshAdapterOptions["spawnForTest"];
  };
}

export const makeDeepSeekEngineAdapter = Effect.fn("makeDeepSeekEngineAdapter")(function* (
  input: DeepSeekEngineAdapterInput,
) {
  const host = yield* DeepSeekEngineHost;
  if (input.engine === "dsh") {
    return yield* makeDeepSeekDshAdapter({
      instanceId: input.instanceId,
      settings: input.settings,
      environment: input.environment,
      selfInvocation: input.selfInvocation,
      registerProcess: host.registerProcess,
      forgetProcess: host.forgetProcess,
      ...(input.dshTest?.dshHome === undefined ? {} : { dshHome: input.dshTest.dshHome }),
      ...(input.dshTest?.spawnForTest === undefined
        ? {}
        : { spawnForTest: input.dshTest.spawnForTest }),
    });
  }
  return yield* makeDeepSeekClaudeAdapter({
    instanceId: input.instanceId,
    settings: input.settings,
    environment: input.environment,
    providerCatalog: input.providerCatalog,
    createClaudeAdapter: host.createClaudeAdapter,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor }),
  });
});
