// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessIsExecutable, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeZip } from "../catalog/archiveFixtures.ts";
import { makeCatalogInstaller } from "../catalog/installer.ts";
import { makeProviderCatalog } from "../catalog/ProviderCatalog.ts";
import { ProviderCatalog } from "../catalog/ProviderCatalog.ts";
import { CatalogInstaller } from "../catalog/installer.ts";
import { REGISTRY_URL } from "../catalog/registry.ts";
import { RegistryAcpDriver } from "./RegistryAcpDriver.ts";
import registryFixture from "../catalog/fixtures/registry-2026-10-20.json" with { type: "json" };

const sha256Hex = (data: Uint8Array) => NodeCrypto.createHash("sha256").update(data).digest("hex");

describe("RegistryAcpDriver Local Proof on throwaway data root", () => {
  it.live("list catalogue -> add checksum-pinned agent -> install -> start ACP session -> remove", () =>
    Effect.gen(function* () {
      const timings: Record<string, number> = {};
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Target agent: amp-acp from official registry fixture
      const targetAgentId = "amp-acp";
      const targetAgentInFixture = registryFixture.agents.find((a: any) => a.id === targetAgentId);
      const ampArchiveUrl = targetAgentInFixture.distribution.binary["windows-x86_64"].archive;
      const cmdName = targetAgentInFixture.distribution.binary["windows-x86_64"].cmd; // "amp-acp.exe"

      // Use cmd.exe binary (real Windows PE executable) as amp-acp.exe, with args calling acp-mock-agent.ts
      const cmdExeBytes = NodeFS.readFileSync(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe");
      const mockAgentScript = path.resolve("apps/server/scripts/acp-mock-agent.ts");
      const zipArchive = makeZip([
        { name: cmdName, data: cmdExeBytes, mode: 0o100755 },
      ]);
      const zipSha256 = sha256Hex(zipArchive);

      // Pin the checksum and configure args in the fixture
      targetAgentInFixture.distribution.binary["windows-x86_64"].sha256 = zipSha256;
      targetAgentInFixture.distribution.binary["windows-x86_64"].args = ["/c", "node", mockAgentScript];
      const registryPayloadText = JSON.stringify(registryFixture);

      const httpMock = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = request.url;
          if (url === REGISTRY_URL) {
            const body = Buffer.from(registryPayloadText, "utf8");
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "content-length": String(body.byteLength),
                },
              }),
            );
            return Object.defineProperty(response, "stream", {
              value: Stream.make(body),
            });
          }
          if (url === ampArchiveUrl) {
            if (request.method === "HEAD") {
              const response = HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 200,
                  headers: { "content-length": String(zipArchive.byteLength) },
                }),
              );
              return Object.defineProperty(response, "stream", {
                value: Stream.empty,
              });
            }
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 200,
                headers: {
                  "content-type": "application/zip",
                  "content-length": String(zipArchive.byteLength),
                },
              }),
            );
            return Object.defineProperty(response, "stream", {
              value: Stream.make(zipArchive),
            });
          }
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 404 }),
          );
          return Object.defineProperty(response, "stream", {
            value: Stream.empty,
          });
        }),
      );

      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-proof-root-" });
      const runtimesRoot = path.join(tempDir, "runtimes");
      const downloadsRoot = path.join(tempDir, "downloads");
      yield* fs.makeDirectory(runtimesRoot, { recursive: true });
      yield* fs.makeDirectory(downloadsRoot, { recursive: true });

      const installer = yield* makeCatalogInstaller({
        runtimesRoot,
        downloadsRoot,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HttpClient.HttpClient, httpMock),
      );

      const catalog = yield* makeProviderCatalog({
        stateDirectory: tempDir,
        platform: "windows-x86_64",
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HttpClient.HttpClient, httpMock),
      );

      const runtimeLayers = Layer.mergeAll(
        Layer.succeed(CatalogInstaller, installer),
        Layer.succeed(ProviderCatalog, catalog),
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      );

      const workflow = Effect.gen(function* () {
        // STEP 1: List Catalogue
        const t0 = Date.now();
        const catalogResult = yield* catalog.list({ refresh: true });
        timings["list"] = Date.now() - t0;
        expect(catalogResult.entries.length).toBeGreaterThanOrEqual(1);
        const found = catalogResult.entries.find((e) => e.catalogId === targetAgentId);
        expect(found).toBeDefined();
        expect(found?.name).toBe("Amp");
        expect(found?.source).toBe("registry");
        expect(found?.sha256Checked).toBe(true);

        // STEP 2: Add checksum-pinned agent (prepare install request)
        const t1 = Date.now();
        const installRequest = yield* catalog.installRequest(targetAgentId);
        timings["add"] = Date.now() - t1;
        expect(installRequest).not.toBeNull();
        expect(installRequest?.agent.id).toBe(targetAgentId);

        // STEP 3: Install
        const t2 = Date.now();
        const waitDone = installer.changes(targetAgentId).pipe(
          Stream.filter((s) => s.phase === "succeeded" || s.phase === "failed" || s.phase === "cancelled"),
          Stream.runHead,
          Effect.map((opt) => opt._tag === "Some" ? opt.value : null),
        );
        const finishedFiber = yield* waitDone.pipe(Effect.forkChild);
        const startResult = yield* installer.start(installRequest!);
        expect(startResult.catalogId).toBe(targetAgentId);
        const installedState = yield* Fiber.join(finishedFiber);
        expect(installedState?.phase).toBe("succeeded");
        timings["install"] = Date.now() - t2;

        // STEP 4: Start session through RegistryAcpDriver (ACP initialize)
        const t3 = Date.now();
        const instanceId = ProviderInstanceId.make("reg-proof-instance");
        const driverInstance = yield* RegistryAcpDriver.create({
          instanceId,
          displayName: "Amp ACP Instance",
          environment: { kind: "host" },
          enabled: true,
          config: { catalogId: targetAgentId },
        }).pipe(Effect.provide(runtimeLayers));

        const threadId = ThreadId.make("proof-thread-1");
        const session = yield* driverInstance.adapter.startSession({
          threadId,
          cwd: tempDir,
        });
        timings["startSession"] = Date.now() - t3;
        expect(session.status).toBe("ready");
        expect(session.threadId).toBe(threadId);

        // STEP 5: Remove
        const t4 = Date.now();
        yield* driverInstance.adapter.stopSession(threadId);
        yield* installer.remove(targetAgentId);
        const afterRemove = yield* installer.resolve(targetAgentId);
        timings["remove"] = Date.now() - t4;
        expect(afterRemove).toBeNull();

        timings["total"] = Date.now() - t0;

        console.log("\n=================== LOCAL PROOF RESULTS ===================");
        console.log("Agent Used:     ", targetAgentId, `(${found?.name} v${found?.version})`);
        console.log("Sha256 Pinned:  ", zipSha256);
        console.log("Data Root:      ", tempDir);
        console.log("Timings:");
        console.log(`  - List catalogue:   ${timings.list} ms`);
        console.log(`  - Add agent facts:  ${timings.add} ms`);
        console.log(`  - Install & verify: ${timings.install} ms`);
        console.log(`  - ACP initialize:   ${timings.startSession} ms`);
        console.log(`  - Teardown & Remove:${timings.remove} ms`);
        console.log(`  - Total runtime:    ${timings.total} ms`);
        console.log("===========================================================\n");
      });

      yield* workflow.pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HttpClient.HttpClient, httpMock),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-proof-test-" })),
      Effect.provide(ServerSettingsService.layerTest()),
      Effect.provide(NodeServices.layer),
    ),
  );
});
