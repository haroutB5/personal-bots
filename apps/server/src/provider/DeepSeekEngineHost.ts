/**
 * Binds the DeepSeek engine seam to the app: the Claude adapter factory with
 * its own services, and the Performance-tab process registry. The provider
 * package owns no app import, so both arrive through this layer.
 * @module provider/DeepSeekEngineHost
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { DeepSeekEngineHost } from "@t3tools/provider-deepseek/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import * as ServerConfig from "../config.ts";
import { forgetBotProviderProcess, registerBotProviderProcess } from "./botProviderProcesses.ts";
import { resolveClaudeModelCatalog } from "./ClaudeModelCatalog.ts";
import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeClaudeTextGeneration } from "../textGeneration/ClaudeTextGeneration.ts";

export const layer = Layer.effect(
  DeepSeekEngineHost,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const queryRunner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;

    return DeepSeekEngineHost.of({
      createClaudeAdapter: (input) =>
        ClaudeAdapterV2.createClaudeAdapterV2(input.create, {
          modelCatalog: Effect.map(input.providerCatalog, resolveClaudeModelCatalog),
        }).pipe(
          Effect.provideService(HostProcess.Environment, input.processEnvironment),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SecureRandom.SecureRandom, random),
          Effect.provideService(IdAllocator.IdAllocatorV2, idAllocator),
          Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, queryRunner),
          Effect.provideService(ServerConfig.ServerConfig, serverConfig),
          Effect.provideService(
            ProviderContinuationRequests.ProviderContinuationRequests,
            continuationRequests,
          ),
          Effect.provideService(McpProviderSessions.McpProviderSessions, mcpSessions),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(
            ProviderInstallationGate.ProviderInstallationGate,
            installationGate,
          ),
        ),
      createTextGeneration: (input) =>
        makeClaudeTextGeneration(
          input.settings,
          input.environment,
          Effect.map(input.providerCatalog, resolveClaudeModelCatalog),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      registerProcess: (input) => {
        registerBotProviderProcess(input);
      },
      forgetProcess: (threadId, pid) => {
        forgetBotProviderProcess(threadId, pid);
      },
    });
  }),
);
