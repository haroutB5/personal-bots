// @effect-diagnostics nodeBuiltinImport:off - the live proof writes a result file and reads the environment.
/**
 * Live proof for the registry-agent installer, off by default.
 *
 *   HBOTS_CATALOG_LIVE=1 [HBOTS_CATALOG_LIVE_BINARY=amp-acp] [HBOTS_CATALOG_LIVE_NPM=pi-acp] \
 *     [HBOTS_CATALOG_LIVE_OUT=<result.json>] vp test run src/provider/catalog/catalogLive.test.ts
 *
 * It fetches the real registry, then installs one real binary agent (a real
 * download, the registry's sha256 checked, real unpack, real ACP `initialize`)
 * and one real npm agent (real `npm install` of the pinned version, integrity
 * recorded, real `initialize`) into a fresh temp folder, never the live data
 * root, and deletes the folder afterwards.
 *
 * Run it by hand: it downloads tens of megabytes and starts third-party
 * programs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { makeCatalogInstaller } from "./installer.ts";
import { makeProviderCatalog } from "./ProviderCatalog.ts";

const live = process.env.HBOTS_CATALOG_LIVE === "1";
const binaryId = process.env.HBOTS_CATALOG_LIVE_BINARY ?? "amp-acp";
const npmId = process.env.HBOTS_CATALOG_LIVE_NPM ?? "pi-acp";
const outPath = process.env.HBOTS_CATALOG_LIVE_OUT;

const InstallRecordShape = Schema.Struct({
  version: Schema.String,
  kind: Schema.String,
  runner: Schema.String,
  entry: Schema.String,
  archive: Schema.NullOr(
    Schema.Struct({
      sha256: Schema.String,
      sha256Source: Schema.String,
      bytes: Schema.Number,
      host: Schema.String,
    }),
  ),
  npm: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      integrity: Schema.String,
      registryHost: Schema.String,
    }),
  ),
  agentName: Schema.NullOr(Schema.String),
  agentVersion: Schema.NullOr(Schema.String),
  protocolVersion: Schema.Number,
});
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe.skipIf(!live)("registry agents, live", () => {
  it.live(
    "installs one real binary agent and one real npm agent into a temp folder",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "hbots-catalog-live-" });
        const summary: Array<Record<string, unknown>> = [];
        yield* Effect.gen(function* () {
          const catalog = yield* makeProviderCatalog({ stateDirectory: path.join(root, "state") });
          const list = yield* catalog.list({ refresh: true });
          expect(list.registryFetchedAt).not.toBeNull();
          const installer = yield* makeCatalogInstaller({
            runtimesRoot: path.join(root, "runtimes"),
            npm: { cacheDirectory: path.join(root, "npm-cache") },
          });
          for (const id of [binaryId, npmId]) {
            const request = yield* catalog.installRequest(id);
            expect(request, `${id} is in the registry`).not.toBeNull();
            const plan = yield* catalog.installPlan(id);
            const entry = list.entries.find((candidate) => candidate.catalogId === id);
            const startedAt = yield* Clock.currentTimeMillis;
            const started = yield* installer.start(request!);
            const phases: string[] = [];
            const done = yield* installer.changes(id).pipe(
              Stream.tap((state) =>
                Effect.sync(
                  () => void (phases.at(-1) === state.phase ? undefined : phases.push(state.phase)),
                ),
              ),
              Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            const seconds = ((yield* Clock.currentTimeMillis) - startedAt) / 1000;
            const directory = path.join(root, "runtimes", id, request!.agent.version);
            const record = yield* fs
              .readFileString(path.join(directory, ".install-complete.json"))
              .pipe(
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InstallRecordShape))),
                Effect.option,
              );
            summary.push({
              id,
              planKind: plan?.kind,
              operationId: started.operationId === null ? null : "set",
              finalPhase: done.phase,
              failure: done.failure,
              phases,
              seconds,
              downloadedBytes: done.downloadedBytes,
              catalogDownloadBytes: entry?.downloadBytes ?? null,
              catalogSha256Checked: entry?.sha256Checked ?? null,
              record: Option.getOrNull(record),
            });
            expect(done.failure, `${id} install failure`).toBeNull();
            expect(done.phase).toBe("succeeded");
            expect(Option.isSome(record)).toBe(true);
            if (plan?.kind === "binary") {
              expect(Option.getOrThrow(record).archive?.sha256).toBe(plan.sha256);
            } else {
              expect(Option.getOrThrow(record).npm?.integrity).toMatch(/^sha(?:256|384|512)-/u);
            }
            expect(Option.getOrThrow(record).protocolVersion).toBeGreaterThanOrEqual(1);
          }
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.ensuring(
            Effect.gen(function* () {
              if (outPath !== undefined) {
                yield* fs.writeFileString(outPath, yield* encodeSummary(summary));
              }
              yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore);
            }).pipe(Effect.ignore),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    15 * 60 * 1000,
  );
});
