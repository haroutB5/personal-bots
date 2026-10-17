/**
 * The DeepSeek card's update advisory, on both engines.
 *
 * Both engines compare against a published package now: the Claude engine
 * against `@anthropic-ai/claude-code` (`latest`), and the harness against
 * `@deepseek-ai/dsh`, taking the newest of `latest` and `next` and never
 * `alpha`. The harness has no update action because moving the pin needs a
 * release, but the card still says when a newer harness is published.
 *
 * Two bugs this guards: dsh used to compare against the Claude CLI's latest
 * and show a false "Update available", and then had no lookup at all, so a
 * harness published on `next` was invisible until someone read the notes.
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
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { DSH_PINNED_VERSION } from "./DeepSeekEngine.ts";
import { DeepSeekDriver } from "./DeepSeekDriver.ts";

/** The Claude CLI's latest, as the registry answered it in the QA finding. */
const CLAUDE_CLI_LATEST = "2.1.296";
/** A Claude CLI old enough to be behind that. */
const CLAUDE_CLI_RUNNING = "2.1.290";
/** What npm publishes for the harness: rc on `next`, an older release on `latest`. */
const DSH_REGISTRY = { latest: "0.2.0-rc.2", next: "0.2.1-rc.2", alpha: "0.3.0-alpha.1" } as const;

const makeConfig = (overrides: Partial<DeepSeekSettings>): DeepSeekSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  engine: "dsh",
  dshRuntimePath: "",
  peakSwitch: true,
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
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              version: request.url.includes("deepseek-ai")
                ? request.url.endsWith("/next")
                  ? DSH_REGISTRY.next
                  : request.url.endsWith("/alpha")
                    ? DSH_REGISTRY.alpha
                    : DSH_REGISTRY.latest
                : CLAUDE_CLI_LATEST,
            }),
          ),
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

/**
 * Everything a consumer reads to decide "can a bot run on this provider": the
 * bot form, the bot rows, Team and the task cards all go through
 * `isProviderAvailable` / `snapshot.enabled` / `snapshot.installed` (plus the
 * model slugs they offer). None of them reads the version advisory, so the two
 * engines must agree here field for field.
 */
const availabilityShape = (snapshot: ServerProvider) => ({
  enabled: snapshot.enabled,
  installed: snapshot.installed,
  status: snapshot.status,
  availability: snapshot.availability,
  unavailableReason: snapshot.unavailableReason,
  auth: snapshot.auth,
  modelSlugs: snapshot.models.map((entry) => entry.slug).sort(),
});

it.layer(testLayer)("DeepSeekDriver version advisory", (it) => {
  it.effect("dsh: looks up latest and next, never alpha, and shows the newer harness", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeRegistryStub();
      const instance = yield* createInstance("dsh");
      const capabilities = yield* instance.snapshot.resolveMaintenance();

      // The harness is published, so its card can say a newer one exists; it
      // has no update action because moving the pin needs a release.
      expect(capabilities.packageName).toBe("@deepseek-ai/dsh");
      expect(capabilities.latestVersionTags).toEqual(["latest", "next"]);
      expect(capabilities.update).toBeNull();

      const snapshot = yield* instance.snapshot.getSnapshot;
      const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
        // A harness one release behind `next`.
        runningSnapshot(snapshot, "0.2.1-rc.1"),
        capabilities,
        { enableProviderUpdateChecks: true },
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );

      expect(enriched.versionAdvisory).toMatchObject({
        status: "behind_latest",
        currentVersion: "0.2.1-rc.1",
        latestVersion: "0.2.1-rc.2",
        canUpdate: false,
      });
      expect(enriched.versionAdvisory?.message).not.toBeNull();
      const lookedUp = yield* Ref.get(requests);
      expect(lookedUp.filter((url) => url.endsWith("/latest"))).toHaveLength(1);
      expect(lookedUp.filter((url) => url.endsWith("/next"))).toHaveLength(1);
      // `alpha` is never considered, even when it is higher than `next`.
      expect(lookedUp.some((url) => url.includes("/alpha"))).toBe(false);
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

  // The bug this guards: reading "no package to look up" as "not installed".
  // The provider is reported as available or not from `enabled`/`installed`/
  // `status`/`availability`, and the dsh engine must be exactly as ready as the
  // Claude engine. A regression here is invisible in the advisory tests above
  // and takes DeepSeek out of the new-bot form.
  it.effect("dsh: the same availability as the claude-code engine, advisory aside", () =>
    Effect.gen(function* () {
      const { client } = yield* makeRegistryStub();
      const dsh = yield* createInstance("dsh");
      const claude = yield* createInstance("claude-code");
      const [dshSnapshot, claudeSnapshot] = yield* Effect.all([
        dsh.snapshot.getSnapshot,
        claude.snapshot.getSnapshot,
      ]);
      expect(availabilityShape(dshSnapshot)).toEqual(availabilityShape(claudeSnapshot));

      const dshReady = runningSnapshot(dshSnapshot, DSH_PINNED_VERSION);
      const claudeReady = runningSnapshot(claudeSnapshot, CLAUDE_CLI_RUNNING);
      const enrich = (
        snapshot: ServerProvider,
        resolveMaintenance: () => Effect.Effect<ProviderMaintenanceCapabilities>,
      ) =>
        resolveMaintenance().pipe(
          Effect.flatMap((capabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities, {
              enableProviderUpdateChecks: true,
            }),
          ),
        );
      const [dshEnriched, claudeEnriched] = yield* Effect.all([
        enrich(dshReady, dsh.snapshot.resolveMaintenance),
        enrich(claudeReady, claude.snapshot.resolveMaintenance),
      ]).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderVersionCache, new Map()),
      );

      // The harness snapshot stays available, installed, ready and
      // authenticated: only the advisory differs.
      expect(availabilityShape(dshEnriched)).toEqual(availabilityShape(claudeEnriched));
      expect(availabilityShape(dshEnriched)).toEqual(availabilityShape(dshReady));
      expect(dshEnriched.enabled).toBe(true);
      expect(dshEnriched.availability).toBeUndefined();
      expect(dshEnriched.unavailableReason).toBeUndefined();
      expect(dshEnriched.versionAdvisory?.status).toBe("current");
      expect(dshEnriched.versionAdvisory?.canUpdate).toBe(false);
      expect(claudeEnriched.versionAdvisory?.status).toBe("behind_latest");
    }).pipe(Effect.scoped),
  );
});
