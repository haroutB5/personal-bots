import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersonalBotService } from "../../personal/PersonalBotService.ts";
import { makeProviderInstallation } from "../providerInstallation.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeCatalogInstaller, CatalogInstaller } from "../catalog/installer.ts";
import { makeProviderCatalog, ProviderCatalog } from "../catalog/ProviderCatalog.ts";
import { RegistryAcpDriver } from "./RegistryAcpDriver.ts";

const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Opt in: real third-party download and process, always isolated from the live server.
describe.skipIf(process.env.HBOTS_CATALOG_DRIVER_LIVE !== "1")("Registry ACP local proof", () => {
  it.live(
    "lists, adds, installs a pinned binary, initializes through the driver and removes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-registry-driver-proof-" });
        const settings = yield* ServerSettingsService;
        const catalog = yield* makeProviderCatalog({ stateDirectory: path.join(root, "state") });
        const agentHome = path.join(root, "agent-home");
        yield* fs.makeDirectory(agentHome, { recursive: true });
        const homeEnv = Object.fromEntries(
          [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
          ].map((name) => [name, agentHome]),
        );
        const installer = yield* makeCatalogInstaller({
          runtimesRoot: path.join(root, "runtimes"),
        }).pipe(Effect.provideService(HostProcessEnvironment, { ...process.env, ...homeEnv }));
        const timings: Record<string, number> = {};
        const startedAt = yield* Clock.currentTimeMillis;
        const list = yield* catalog.list({ refresh: true });
        timings.list = (yield* Clock.currentTimeMillis) - startedAt;
        const id = process.env.HBOTS_CATALOG_DRIVER_PROOF_AGENT ?? "kilo";
        const entry = list.entries.find((candidate) => candidate.catalogId === id);
        expect(entry?.sha256Checked).toBe(true);
        const plan = yield* catalog.installPlan(id);
        expect(plan?.kind).toBe("binary");
        const addAt = yield* Clock.currentTimeMillis;
        const instanceId = ProviderInstanceId.make("registry-proof-amp");
        yield* settings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: RegistryAcpDriver.driverKind,
              displayName: "Proof Amp",
              enabled: true,
              config: { catalogId: id },
            },
          },
        });
        expect((yield* settings.getSettings).providerInstances[instanceId]?.driver).toBe(
          "registry",
        );
        timings.add = (yield* Clock.currentTimeMillis) - addAt;
        const installAt = yield* Clock.currentTimeMillis;
        const request = yield* catalog.installRequest(id);
        expect(request).not.toBeNull();
        yield* installer.start(request!);
        const done = yield* installer.changes(id).pipe(
          Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(done.failure).toBeNull();
        expect(done.phase).toBe("succeeded");
        timings.install = (yield* Clock.currentTimeMillis) - installAt;
        const initializeAt = yield* Clock.currentTimeMillis;
        const driver = yield* RegistryAcpDriver.create({
          instanceId,
          displayName: "Kilo",
          environment: [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
          ].map((name) => ({ name, value: agentHome, sensitive: false })),
          enabled: true,
          config: { catalogId: id },
        }).pipe(
          Effect.provideService(CatalogInstaller, installer),
          Effect.provideService(ProviderCatalog, catalog),
          Effect.provideService(ProviderEventLoggers, NoOpProviderEventLoggers),
        );
        // The health check: starts Kilo (initialize + session/new), no prompt.
        const checkAt = yield* Clock.currentTimeMillis;
        const checked = yield* driver.snapshot.refresh;
        timings.healthCheck = (yield* Clock.currentTimeMillis) - checkAt;
        const modelCount = checked.models.length;
        expect(modelCount).toBeGreaterThan(0);
        // A new agent home has no Kilo login, so Kilo must read as needing sign-in.
        expect(checked.auth.status).toBe("unauthenticated");
        expect(checked.message?.split("\n")[0]).toContain("kilo auth login");
        // A bot's turn: Kilo takes the prompt and then never answers when signed out.
        const threadId = ThreadId.make("registry-proof-thread");
        const session = yield* driver.adapter.startSession({
          threadId,
          cwd: root,
          runtimeMode: "approval-required",
        });
        expect(session.status).toBe("ready");
        timings.initialize = (yield* Clock.currentTimeMillis) - initializeAt;
        const turnAt = yield* Clock.currentTimeMillis;
        const turnError = yield* driver.adapter
          .sendTurn({ threadId, input: "Say hello in one word." })
          .pipe(Effect.flip);
        timings.signedOutTurnFailure = (yield* Clock.currentTimeMillis) - turnAt;
        expect(turnError.message).toContain("Kilo needs you to sign in");
        expect(turnError.message).toContain("kilo auth login");
        expect(timings.signedOutTurnFailure).toBeLessThan(90_000);
        expect(yield* driver.adapter.hasSession(threadId)).toBe(false);
        // Remove: the install and the settings instance go, and the provider is no longer offered.
        const removeAt = yield* Clock.currentTimeMillis;
        const installation = yield* makeProviderInstallation().pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerSettingsService, settings),
              Layer.succeed(CatalogInstaller, installer),
              Layer.succeed(ProviderCatalog, catalog),
              Layer.mock(AntigravityInstallation)({ managedDirectory: root }),
              Layer.mock(ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(driver),
                listInstances: Effect.succeed([driver]),
              }),
              Layer.mock(ProviderRegistry)({ refreshInstance: () => Effect.succeed([]) }),
              Layer.mock(ProjectionSnapshotQuery)({}),
              Layer.mock(PersonalBotService)({
                list: () =>
                  Effect.succeed({ bots: [], threads: [], personalProjectId: "default" as never }),
              }),
            ),
          ),
        );
        yield* installation.remove({ instanceId });
        expect(yield* installer.resolve(id)).toBeNull();
        expect((yield* settings.getSettings).providerInstances[instanceId]).toBeUndefined();
        timings.remove = (yield* Clock.currentTimeMillis) - removeAt;
        timings.total = (yield* Clock.currentTimeMillis) - startedAt;
        const summary = {
          agent: id,
          version: request!.agent.version,
          checksum: plan?.kind === "binary" ? plan.sha256 : null,
          modelCount,
          timings,
        };
        yield* Effect.logInfo("Registry driver local proof", summary);
        const output = process.env.HBOTS_CATALOG_DRIVER_PROOF_OUT;
        if (output) yield* fs.writeFileString(output, yield* encodeSummary(summary));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(process.cwd(), { prefix: "hbots-registry-proof-config-" }),
            ServerSettingsService.layerTest(),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
            }),
            FetchHttpClient.layer,
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    10 * 60 * 1000,
  );
});
