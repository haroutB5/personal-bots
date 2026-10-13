/**
 * The DeepSeek card's update advisory, on both engines.
 *
 * One provider, two engines with different update channels: the Claude CLI is
 * a published package whose latest version the advisory can look up, while the
 * harness is pinned and moves only with `install-dsh.ps1` and a new pin, so it
 * has nothing to compare against. The bug this covers: on dsh the card said
 * "Update available" beside the harness version (v0.2.0-rc.2), because the
 * lookup ran against `@anthropic-ai/claude-code` and the Claude CLI's latest
 * (2.1.296) is newer than any harness version.
 *
 * The assertions drive the same two calls the driver's own `enrichSnapshot`
 * makes: `snapshot.resolveMaintenance()` for the capabilities, then
 * `enrichProviderSnapshotWithVersionAdvisory` for the advisory the card reads.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type DeepSeekSettings, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as UsageService from "../../usage/UsageService.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  ProviderVersionCache,
} from "../providerMaintenance.ts";
import { DSH_PINNED_VERSION } from "./DeepSeekEngine.ts";
import { DeepSeekDriver } from "./DeepSeekDriver.ts";

/** The Claude CLI's latest, as the registry answered it in the QA finding. */
const CLAUDE_CLI_LATEST = "2.1.296";
/** A Claude CLI old enough to be behind that. */
const CLAUDE_CLI_RUNNING = "2.1.290";

const makeConfig = (overrides: Partial<DeepSeekSettings>): DeepSeekSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  engine: "dsh",
  dshRuntimePath: "",
  ...overrides,
});

/**
 * A client that answers the npm registry and records what was asked for, so a
 * test can prove a lookup did (or did not) happen.
 */
const makeRegistryStub = () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<Array<string>>([]);
    const client = HttpClient.make((request) =>
      Ref.update(requests, (all) => [...all, request.url]).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(request, Response.json({ version: CLAUDE_CLI_LATEST })),
        ),
      ),
    );
    return { client, requests };
  });

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-deepseek-driver-advisory-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  // Building the driver must not reach the network; each test hands the
  // advisory its own recording registry stub.
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Driver creation must not make an HTTP request")),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(UsageService.layerTest),
);

const createInstance = (engine: DeepSeekSettings["engine"]) =>
  DeepSeekDriver.create({
    instanceId: ProviderInstanceId.make(`deepseek-${engine}-advisory`),
    displayName: "DeepSeek test",
    enabled: false,
    environment: [],
    config: makeConfig({ engine }),
  });

/** The machine snapshot the card reads, made look like a live, running provider. */
const runningSnapshot = (snapshot: ServerProvider, version: string): ServerProvider => ({
  ...snapshot,
  enabled: true,
  installed: true,
  status: "ready",
  version,
});

it.layer(testLayer)("DeepSeekDriver version advisory", (it) => {
  it.effect("dsh: no update lookup, and no advisory to show", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeRegistryStub();
      const instance = yield* createInstance("dsh");
      const capabilities = yield* instance.snapshot.resolveMaintenance();

      // Nothing to look up: the harness is pinned, not published.
      expect(capabilities.packageName).toBeNull();
      expect(capabilities.update).toBeNull();

      const snapshot = yield* instance.snapshot.getSnapshot;
      const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
        runningSnapshot(snapshot, DSH_PINNED_VERSION),
        capabilities,
        { enableProviderUpdateChecks: true },
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );

      // `unknown` is what the card turns into "no advisory" (no arrow, no
      // "Update available" line); `behind_latest` was the false one.
      expect(enriched.versionAdvisory?.status).toBe("unknown");
      expect(enriched.versionAdvisory?.message).toBeNull();
      expect(yield* Ref.get(requests)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("claude-code: the Claude CLI's own package, and today's advisory", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeRegistryStub();
      const instance = yield* createInstance("claude-code");
      const capabilities = yield* instance.snapshot.resolveMaintenance();

      expect(capabilities.packageName).toBe("@anthropic-ai/claude-code");

      const snapshot = yield* instance.snapshot.getSnapshot;
      const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
        runningSnapshot(snapshot, CLAUDE_CLI_RUNNING),
        capabilities,
        { enableProviderUpdateChecks: true },
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );

      const lookedUp = yield* Ref.get(requests);
      expect(lookedUp).toHaveLength(1);
      expect(lookedUp[0]).toContain("registry.npmjs.org");
      expect(lookedUp[0]).toContain("claude-code");
      expect(enriched.versionAdvisory).toMatchObject({
        status: "behind_latest",
        currentVersion: CLAUDE_CLI_RUNNING,
        latestVersion: CLAUDE_CLI_LATEST,
      });
      expect(enriched.versionAdvisory?.message).not.toBeNull();
    }).pipe(Effect.scoped),
  );
});
