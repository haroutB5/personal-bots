import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ProviderCatalogInstallState } from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";

import type { AcpSmoke } from "./acpSmoke.ts";
import { makeTarGz, makeZip } from "./archiveFixtures.ts";
import { installError } from "./errors.ts";
import { makeCatalogInstaller, type CatalogInstallerOptions } from "./installer.ts";
import type { RegistryAgent } from "./registry.ts";

const win = "windows-x86_64" as const;
const sha256 = (data: Uint8Array) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const text = (value: string) => Buffer.from(value);

const agentZip = (extra: ReadonlyArray<{ name: string; data: string }> = []) =>
  makeZip([
    { name: "agent.exe", data: text("EXE v1"), mode: 0o100755 },
    { name: "lib/", directory: true },
    { name: "lib/helper.dll", data: text("DLL") },
    ...extra.map((entry) => ({ name: entry.name, data: text(entry.data) })),
  ]);

interface AgentOptions {
  readonly id?: string;
  readonly version?: string;
  readonly archive?: Buffer;
  readonly format?: "zip" | "tar.gz" | "raw";
  readonly sha256?: string | null;
  readonly cmd?: string;
}

const binaryAgent = (options: AgentOptions = {}): RegistryAgent => {
  const id = options.id ?? "fake-agent";
  const version = options.version ?? "1.0.0";
  const archive = options.archive ?? agentZip();
  const extension =
    options.format === "tar.gz" ? "tar.gz" : options.format === "raw" ? "exe" : "zip";
  return {
    id,
    name: id,
    version,
    description: "",
    repository: null,
    website: null,
    authors: [],
    license: "MIT",
    licenseUrl: null,
    icon: null,
    binary: {
      [win]: {
        archive: `https://downloads.example.com/${id}-${version}.${extension}`,
        cmd: options.cmd ?? "./agent.exe",
        sha256: options.sha256 === undefined ? sha256(archive) : options.sha256,
        args: ["acp"],
        env: { AGENT_FLAG: "1" },
      },
    },
    npm: null,
    uvx: null,
  };
};

interface Route {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: Stream.Stream<Uint8Array, unknown>;
}

type Served = (request: { readonly method: string; readonly url: string }) => Route;

/** Serves one archive for GET and its length for HEAD, in three chunks like a real download. */
const archiveRoute =
  (archive: Buffer, options: { readonly headLength?: boolean } = {}): Served =>
  (request) => {
    if (request.method === "HEAD") {
      return {
        headers:
          options.headLength === false ? {} : { "content-length": String(archive.byteLength) },
      };
    }
    const third = Math.ceil(archive.byteLength / 3);
    return {
      headers: { "content-length": String(archive.byteLength) },
      body: Stream.make(
        archive.subarray(0, third),
        archive.subarray(third, 2 * third),
        archive.subarray(2 * third),
      ),
    };
  };

const okSmoke: AcpSmoke = () =>
  Effect.succeed({
    agentName: "fake",
    agentVersion: "1",
    protocolVersion: 1,
    authMethods: [{ id: "a", name: "A" }],
  });

interface HarnessOptions {
  readonly serve?: Served;
  readonly smoke?: AcpSmoke;
  readonly freeBytes?: CatalogInstallerOptions["freeBytes"];
  readonly npm?: CatalogInstallerOptions["npm"];
  readonly environment?: NodeJS.ProcessEnv;
  /** True makes this a standalone build, so a Node.js must be found on PATH. */
  readonly standalone?: boolean;
}

const makeHarness = Effect.fn("test.makeCatalogInstaller")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-catalog-" });
  const runtimesRoot = path.join(base, "runtimes");
  const requests: string[] = [];
  const spawns: Array<Parameters<AcpSmoke>[0]> = [];
  const serve = options.serve ?? (() => ({ status: 404 }));
  const smoke: AcpSmoke = options.smoke ?? okSmoke;
  const installer = yield* makeCatalogInstaller({
    runtimesRoot,
    platform: win,
    smoke: (spawn) => {
      spawns.push(spawn);
      return smoke(spawn);
    },
    ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
    ...(options.npm === undefined ? {} : { npm: options.npm }),
  }).pipe(
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessIsExecutable, options.standalone ?? false),
    Effect.provideService(
      HostProcessEnvironment,
      options.environment ?? { PATH: "C:\\bin", SECRET_TOKEN: "do-not-leak" },
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(`${request.method} ${request.url}`);
          const route = serve({ method: request.method, url: request.url });
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: route.status ?? 200, headers: route.headers ?? {} }),
          );
          return Object.defineProperty(response, "stream", {
            value: route.body ?? Stream.empty,
          });
        }),
      ),
    ),
  );
  return { installer, fs, path, base, runtimesRoot, requests, spawns };
});

const isTerminal = (state: ProviderCatalogInstallState) =>
  ["succeeded", "failed", "cancelled"].includes(state.phase);

const finished = (
  installer: Effect.Success<ReturnType<typeof makeHarness>>["installer"],
  catalogId: string,
) =>
  installer
    .changes(catalogId)
    .pipe(Stream.filter(isTerminal), Stream.runHead, Effect.map(Option.getOrThrow));

/** Phases an install passes through, collected from the change stream. */
const recordPhases = (
  installer: Effect.Success<ReturnType<typeof makeHarness>>["installer"],
  catalogId: string,
) =>
  Effect.gen(function* () {
    const phases: string[] = [(yield* installer.state(catalogId)).phase];
    const fiber = yield* installer.changes(catalogId).pipe(
      Stream.takeUntil(isTerminal),
      Stream.runForEach((state) =>
        Effect.sync(
          () => void (phases.at(-1) === state.phase ? undefined : phases.push(state.phase)),
        ),
      ),
      Effect.forkScoped,
    );
    /** Resolves with the phases once the install reached a terminal one. */
    return Fiber.join(fiber).pipe(Effect.as(phases));
  });

const dirNames = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readDirectory(directory).pipe(Effect.map((names) => names.toSorted()));

it.layer(NodeServices.layer)("catalog installer: binary archives", (it) => {
  it.effect("downloads, checks the sha256, unpacks, launches, and commits", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, fs, path, runtimesRoot, requests, spawns } = yield* makeHarness({
        serve: archiveRoute(archive),
      });
      const settled = yield* recordPhases(installer, "fake-agent");
      const started = yield* installer.start({ agent: binaryAgent({ archive }) });
      expect(started).toMatchObject({ phase: "resolving", version: "1.0.0", failure: null });
      const done = yield* finished(installer, "fake-agent");
      expect(done).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.0.0",
        previousVersion: null,
        canRemove: true,
        downloadedBytes: archive.byteLength,
        totalBytes: archive.byteLength,
        failure: null,
        message: null,
      });
      expect(yield* settled).toEqual([
        "idle",
        "resolving",
        "downloading",
        "verifying",
        "extracting",
        "starting",
        "succeeded",
      ]);
      // The size comes from HEAD, then the archive from GET; both on the registry's URL.
      expect(requests).toEqual([
        "HEAD https://downloads.example.com/fake-agent-1.0.0.zip",
        "GET https://downloads.example.com/fake-agent-1.0.0.zip",
      ]);
      const directory = path.join(runtimesRoot, "fake-agent", "1.0.0");
      expect(yield* fs.readFileString(path.join(directory, "agent.exe"))).toBe("EXE v1");
      expect(yield* fs.readFileString(path.join(directory, "lib", "helper.dll"))).toBe("DLL");
      expect(yield* dirNames(fs, directory)).toEqual([
        ".install-complete.json",
        "agent.exe",
        "lib",
      ]);
      expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([
        "1.0.0",
        "active.json",
      ]);

      const resolved = yield* installer.resolve("fake-agent");
      expect(resolved).toMatchObject({
        catalogId: "fake-agent",
        version: "1.0.0",
        kind: "binary",
        runner: "native",
        entry: "agent.exe",
        args: ["acp"],
        env: { AGENT_FLAG: "1" },
        directory,
      });
      // The launch check ran from the install folder with a trimmed environment.
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toMatchObject({
        command: path.join(directory, "agent.exe"),
        args: ["acp"],
        cwd: directory,
        extendEnv: false,
      });
      expect(spawns[0]?.env).toMatchObject({ PATH: "C:\\bin", AGENT_FLAG: "1" });
      expect(spawns[0]?.env).not.toHaveProperty("SECRET_TOKEN");
    }),
  );

  it.effect("unpacks a tar.gz and a bare executable", () =>
    Effect.gen(function* () {
      const tar = makeTarGz([
        { name: "pkg/", type: "5" },
        { name: "pkg/cortex.exe", data: text("TAR EXE"), mode: 0o755 },
      ]);
      const first = yield* makeHarness({ serve: archiveRoute(tar) });
      yield* first.installer.start({
        agent: binaryAgent({
          id: "tar-agent",
          archive: tar,
          format: "tar.gz",
          cmd: "./pkg/cortex.exe",
        }),
      });
      expect((yield* finished(first.installer, "tar-agent")).phase).toBe("succeeded");
      expect(
        yield* first.fs.readFileString(
          first.path.join(first.runtimesRoot, "tar-agent", "1.0.0", "pkg", "cortex.exe"),
        ),
      ).toBe("TAR EXE");

      const exe = text("MZ raw program");
      const second = yield* makeHarness({ serve: archiveRoute(exe) });
      yield* second.installer.start({
        agent: binaryAgent({
          id: "raw-agent",
          archive: exe,
          format: "raw",
          cmd: "./raw-agent.exe",
        }),
      });
      expect((yield* finished(second.installer, "raw-agent")).phase).toBe("succeeded");
      expect(
        yield* second.fs.readFileString(
          second.path.join(second.runtimesRoot, "raw-agent", "1.0.0", "raw-agent.exe"),
        ),
      ).toBe("MZ raw program");
    }),
  );

  it.effect(
    "deletes a download that is not the file the publisher listed, without unpacking it",
    () =>
      Effect.gen(function* () {
        const real = agentZip();
        const tampered = agentZip([{ name: "evil.exe", data: "payload" }]);
        const { installer, fs, path, runtimesRoot, spawns } = yield* makeHarness({
          serve: archiveRoute(tampered),
        });
        yield* installer.start({ agent: binaryAgent({ archive: real }) });
        const done = yield* finished(installer, "fake-agent");
        expect(done).toMatchObject({
          phase: "failed",
          failure: { kind: "checksum", host: "downloads.example.com" },
        });
        expect(done.message).toMatch(/wasn't the file the publisher listed/u);
        expect(spawns).toEqual([]);
        // Nothing of it stays: no version folder, no pointer.
        expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([]);
        expect(yield* installer.resolve("fake-agent")).toBeNull();
      }),
  );

  it.effect("refuses before downloading when the volume is too full (2.5 x the download)", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, requests } = yield* makeHarness({
        serve: archiveRoute(archive),
        freeBytes: () => Effect.succeed(Math.ceil(archive.byteLength * 2.5) - 1),
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      const done = yield* finished(installer, "fake-agent");
      expect(done.failure).toEqual({
        kind: "disk",
        detail: "There is not enough free space on this laptop.",
        neededBytes: Math.ceil(archive.byteLength * 2.5),
        freeBytes: Math.ceil(archive.byteLength * 2.5) - 1,
      });
      expect(requests).toEqual(["HEAD https://downloads.example.com/fake-agent-1.0.0.zip"]);
    }),
  );

  it.effect("starts when there is exactly enough room", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer } = yield* makeHarness({
        serve: archiveRoute(archive),
        freeBytes: () => Effect.succeed(Math.ceil(archive.byteLength * 2.5)),
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      expect((yield* finished(installer, "fake-agent")).phase).toBe("succeeded");
    }),
  );

  it.effect("asks for room for a large agent when the size is unknown", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, requests } = yield* makeHarness({
        serve: archiveRoute(archive, { headLength: false }),
        freeBytes: () => Effect.succeed(1024 * 1024 * 1024),
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      const done = yield* finished(installer, "fake-agent");
      expect(done.failure).toMatchObject({ kind: "disk", neededBytes: 1536 * 1024 * 1024 });
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("reports a connection that drops mid-download as network, and cleans up", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, fs, path, runtimesRoot } = yield* makeHarness({
        serve: (request) =>
          request.method === "HEAD"
            ? { headers: { "content-length": String(archive.byteLength) } }
            : {
                headers: { "content-length": String(archive.byteLength) },
                body: Stream.concat(
                  Stream.make(archive.subarray(0, 20)),
                  Stream.fail(new Error("socket hang up")),
                ),
              },
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      const done = yield* finished(installer, "fake-agent");
      expect(done.failure).toMatchObject({ kind: "network", host: "downloads.example.com" });
      expect(done.message).toBe("The connection to downloads.example.com was interrupted.");
      expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([]);
    }),
  );

  it.effect("reports a body shorter than its length as network", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer } = yield* makeHarness({
        serve: (request) =>
          request.method === "HEAD"
            ? { headers: { "content-length": String(archive.byteLength) } }
            : {
                headers: { "content-length": String(archive.byteLength) },
                body: Stream.make(archive.subarray(0, 40)),
              },
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      expect((yield* finished(installer, "fake-agent")).failure).toMatchObject({ kind: "network" });
    }),
  );

  it.effect("stops a body that runs past its declared length", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer } = yield* makeHarness({
        serve: (request) =>
          request.method === "HEAD"
            ? { headers: { "content-length": String(archive.byteLength) } }
            : {
                headers: { "content-length": String(archive.byteLength) },
                body: Stream.make(archive, Buffer.alloc(100_000)),
              },
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      const done = yield* finished(installer, "fake-agent");
      expect(done.failure).toMatchObject({ kind: "network" });
      expect(done.message).toMatch(/sent more data than expected/u);
    }),
  );

  it.effect("reports an HTTP error by host and status", () =>
    Effect.gen(function* () {
      const { installer } = yield* makeHarness({
        serve: (request) => (request.method === "HEAD" ? { status: 405 } : { status: 403 }),
      });
      yield* installer.start({ agent: binaryAgent() });
      const done = yield* finished(installer, "fake-agent");
      expect(done.failure).toEqual({
        kind: "network",
        detail: "downloads.example.com answered 403.",
        host: "downloads.example.com",
      });
    }),
  );

  it.effect(
    "reports an agent that will not start as wontStart, in its own words, and leaves the previous version",
    () =>
      Effect.gen(function* () {
        const v1 = agentZip();
        const v2 = agentZip([{ name: "NEW", data: "2" }]);
        let failNext = false;
        const { installer, fs, path, runtimesRoot } = yield* makeHarness({
          serve: (request) => archiveRoute(request.url.includes("-2.0.0") ? v2 : v1)(request),
          smoke: () =>
            failNext
              ? Effect.fail(installError("wontStart", "unsupported platform"))
              : okSmoke({ command: "x", args: [] }),
        });
        yield* installer.start({ agent: binaryAgent({ version: "1.0.0", archive: v1 }) });
        expect((yield* finished(installer, "fake-agent")).phase).toBe("succeeded");
        failNext = true;
        yield* installer.start({ agent: binaryAgent({ version: "2.0.0", archive: v2 }) });
        const done = yield* finished(installer, "fake-agent");
        expect(done).toMatchObject({
          phase: "failed",
          failure: { kind: "wontStart", detail: "unsupported platform" },
          installedVersion: "1.0.0",
        });
        expect((yield* installer.resolve("fake-agent"))?.version).toBe("1.0.0");
        expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([
          "1.0.0",
          "active.json",
        ]);
      }),
  );

  it.effect(
    "fails with unsupported, without a single request, when the registry gives no way to install",
    () =>
      Effect.gen(function* () {
        const { installer, requests } = yield* makeHarness({ serve: () => ({ status: 500 }) });
        yield* installer.start({ agent: binaryAgent({ id: "no-hash", sha256: null }) });
        const noHash = yield* finished(installer, "no-hash");
        expect(noHash.failure).toMatchObject({ kind: "unsupported" });
        expect(noHash.message).toMatch(/lists no fingerprint/u);
        const uv: RegistryAgent = {
          ...binaryAgent({ id: "uv-agent" }),
          binary: {},
          uvx: { spec: "x==1.0.0", name: null, version: null, args: [], env: {} },
        };
        yield* installer.start({ agent: uv });
        const done = yield* finished(installer, "uv-agent");
        expect(done.failure).toMatchObject({
          kind: "unsupported",
          detail: "It needs uv, a Python tool that isn't on this laptop.",
        });
        expect(requests).toEqual([]);
      }),
  );

  it.effect("keeps exactly one previous version, and Go back switches to it", () =>
    Effect.gen(function* () {
      const archives: Record<string, Buffer> = {
        "1.0.0": agentZip([{ name: "v", data: "1" }]),
        "2.0.0": agentZip([{ name: "v", data: "2" }]),
        "3.0.0": agentZip([{ name: "v", data: "3" }]),
      };
      const { installer, fs, path, runtimesRoot } = yield* makeHarness({
        serve: (request) =>
          archiveRoute(archives[/-(\d\.0\.0)\./u.exec(request.url)![1]!]!)(request),
      });
      for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
        yield* installer.start({ agent: binaryAgent({ version, archive: archives[version]! }) });
        expect((yield* finished(installer, "fake-agent")).phase).toBe("succeeded");
      }
      const state = yield* installer.state("fake-agent");
      expect(state).toMatchObject({ installedVersion: "3.0.0", previousVersion: "2.0.0" });
      // 1.0.0 is gone; 2.0.0 stays for Go back.
      expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([
        "2.0.0",
        "3.0.0",
        "active.json",
      ]);

      const back = yield* installer.goBack("fake-agent");
      expect(back).toMatchObject({ version: "2.0.0", previousVersion: "3.0.0" });
      expect(yield* installer.state("fake-agent")).toMatchObject({
        installedVersion: "2.0.0",
        previousVersion: "3.0.0",
        phase: "idle",
      });
      expect((yield* installer.resolve("fake-agent"))?.version).toBe("2.0.0");
      expect(yield* fs.readFileString(path.join(runtimesRoot, "fake-agent", "2.0.0", "v"))).toBe(
        "2",
      );
    }),
  );

  it.effect("cannot go back without a kept previous version", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer } = yield* makeHarness({ serve: archiveRoute(archive) });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      yield* finished(installer, "fake-agent");
      const exit = yield* Effect.exit(installer.goBack("fake-agent"));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((yield* installer.resolve("fake-agent"))?.version).toBe("1.0.0");
    }),
  );

  it.effect("keeps the working version when an update fails its checksum", () =>
    Effect.gen(function* () {
      const v1 = agentZip();
      const v2 = agentZip([{ name: "new", data: "2" }]);
      const { installer, fs, path, runtimesRoot } = yield* makeHarness({
        serve: (request) =>
          archiveRoute(
            request.url.includes("-2.0.0") ? agentZip([{ name: "other", data: "x" }]) : v1,
          )(request),
      });
      yield* installer.start({ agent: binaryAgent({ version: "1.0.0", archive: v1 }) });
      yield* finished(installer, "fake-agent");
      yield* installer.start({ agent: binaryAgent({ version: "2.0.0", archive: v2 }) });
      expect((yield* finished(installer, "fake-agent")).failure?.kind).toBe("checksum");
      expect((yield* installer.resolve("fake-agent"))?.version).toBe("1.0.0");
      expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([
        "1.0.0",
        "active.json",
      ]);
    }),
  );

  it.effect("does not download the same complete version again when it still starts", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, requests } = yield* makeHarness({ serve: archiveRoute(archive) });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      yield* finished(installer, "fake-agent");
      const before = requests.length;
      yield* installer.start({ agent: binaryAgent({ archive }) });
      expect((yield* finished(installer, "fake-agent")).phase).toBe("succeeded");
      expect(requests.length).toBe(before);
    }),
  );

  it.effect("rebuilds the same version from scratch when the installed copy no longer starts", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      let launches = 0;
      const { installer, requests } = yield* makeHarness({
        serve: archiveRoute(archive),
        smoke: () => {
          launches += 1;
          return launches === 2
            ? Effect.fail(installError("wontStart", "broken"))
            : okSmoke({ command: "x", args: [] });
        },
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      yield* finished(installer, "fake-agent");
      const before = requests.length;
      yield* installer.start({ agent: binaryAgent({ archive }) });
      expect((yield* finished(installer, "fake-agent")).phase).toBe("succeeded");
      expect(requests.length).toBeGreaterThan(before);
    }),
  );

  it.effect(
    "cancels mid-download, removes the partial folder, and leaves the previous version",
    () =>
      Effect.gen(function* () {
        const v1 = agentZip();
        const v2 = agentZip([{ name: "2", data: "2" }]);
        const gate = yield* Deferred.make<void>();
        const reachedBody = yield* Deferred.make<void>();
        const { installer, fs, path, runtimesRoot } = yield* makeHarness({
          serve: (request) =>
            request.url.includes("-2.0.0") && request.method === "GET"
              ? {
                  headers: { "content-length": String(v2.byteLength) },
                  body: Stream.concat(
                    Stream.make(v2.subarray(0, 30)),
                    Stream.fromEffect(
                      Deferred.succeed(reachedBody, undefined).pipe(
                        Effect.andThen(Deferred.await(gate)),
                        Effect.as(new Uint8Array()),
                      ),
                    ),
                  ),
                }
              : archiveRoute(request.url.includes("-2.0.0") ? v2 : v1)(request),
        });
        yield* installer.start({ agent: binaryAgent({ version: "1.0.0", archive: v1 }) });
        yield* finished(installer, "fake-agent");
        const started = yield* installer.start({
          agent: binaryAgent({ version: "2.0.0", archive: v2 }),
        });
        yield* Deferred.await(reachedBody);
        const cancelled = yield* installer.cancel("fake-agent", started.operationId!);
        expect(cancelled.phase === "cancelled" || cancelled.phase === "downloading").toBe(true);
        const done = yield* finished(installer, "fake-agent");
        expect(done).toMatchObject({
          phase: "cancelled",
          failure: null,
          installedVersion: "1.0.0",
        });
        expect(done.message).toMatch(/previous version is unchanged/u);
        expect(yield* dirNames(fs, path.join(runtimesRoot, "fake-agent"))).toEqual([
          "1.0.0",
          "active.json",
        ]);
      }),
  );

  it.effect(
    "refuses a second start for the same provider while one runs, and queues a different one",
    () =>
      Effect.gen(function* () {
        const archive = agentZip();
        const gate = yield* Deferred.make<void>();
        const reachedBody = yield* Deferred.make<void>();
        const { installer } = yield* makeHarness({
          serve: (request) =>
            request.url.includes("slow-agent") && request.method === "GET"
              ? {
                  headers: { "content-length": String(archive.byteLength) },
                  body: Stream.concat(
                    Stream.make(archive.subarray(0, 10)),
                    Stream.fromEffect(
                      Deferred.succeed(reachedBody, undefined).pipe(
                        Effect.andThen(Deferred.await(gate)),
                        Effect.as(archive.subarray(10)),
                      ),
                    ),
                  ),
                }
              : archiveRoute(archive)(request),
        });
        const first = yield* installer.start({ agent: binaryAgent({ id: "slow-agent", archive }) });
        yield* Deferred.await(reachedBody);
        const again = yield* installer.start({ agent: binaryAgent({ id: "slow-agent", archive }) });
        expect(again.operationId).toBe(first.operationId);
        // A second provider waits for the first: one download at a time on this laptop.
        yield* installer.start({ agent: binaryAgent({ id: "other-agent", archive }) });
        const waiting = yield* installer.changes("other-agent").pipe(
          Stream.filter((state) => state.message === "Waiting for another install to finish."),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(waiting.phase).toBe("resolving");
        yield* Deferred.succeed(gate, undefined);
        expect((yield* finished(installer, "slow-agent")).phase).toBe("succeeded");
        expect((yield* finished(installer, "other-agent")).phase).toBe("succeeded");
      }),
  );

  it.effect("sweeps what an interrupted install left behind", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, fs, path, runtimesRoot } = yield* makeHarness({
        serve: archiveRoute(archive),
      });
      const agentDir = path.join(runtimesRoot, "fake-agent");
      yield* fs.makeDirectory(path.join(agentDir, "0.9.0"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "0.9.0", "half"), "partial");
      yield* fs.makeDirectory(path.join(agentDir, ".junk"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "active.json.abcd1234.tmp"), "{}");
      // A leftover of the very version being installed is replaced, not trusted.
      yield* fs.makeDirectory(path.join(agentDir, "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "1.0.0", "stale.txt"), "old");
      yield* installer.start({ agent: binaryAgent({ archive }) });
      expect((yield* finished(installer, "fake-agent")).phase).toBe("succeeded");
      expect(yield* dirNames(fs, agentDir)).toEqual(["1.0.0", "active.json"]);
      expect(yield* fs.exists(path.join(agentDir, "1.0.0", "stale.txt"))).toBe(false);
    }),
  );

  it.effect("remove deletes the folder; a lease blocks it until the chat is done", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, fs, path, runtimesRoot } = yield* makeHarness({
        serve: archiveRoute(archive),
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      yield* finished(installer, "fake-agent");
      const agentDir = path.join(runtimesRoot, "fake-agent");

      const refused = yield* Effect.scoped(
        Effect.gen(function* () {
          const leased = yield* installer.acquire("fake-agent");
          expect(leased.version).toBe("1.0.0");
          return yield* Effect.exit(installer.remove("fake-agent"));
        }),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      expect(yield* fs.exists(agentDir)).toBe(true);

      yield* installer.remove("fake-agent");
      expect(yield* fs.exists(agentDir)).toBe(false);
      expect(yield* installer.state("fake-agent")).toMatchObject({
        phase: "idle",
        installedVersion: null,
        canRemove: false,
      });
      expect(yield* installer.resolve("fake-agent")).toBeNull();
      expect(
        Exit.isFailure(yield* Effect.exit(Effect.scoped(installer.acquire("fake-agent")))),
      ).toBe(true);
    }),
  );

  it.effect("starts from what is on disk after a restart", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const first = yield* makeHarness({ serve: archiveRoute(archive) });
      yield* first.installer.start({ agent: binaryAgent({ archive }) });
      yield* finished(first.installer, "fake-agent");
      const second = yield* makeCatalogInstaller({
        runtimesRoot: first.runtimesRoot,
        platform: win,
        smoke: okSmoke,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no network")),
        ),
      );
      expect(yield* second.state("fake-agent")).toMatchObject({
        phase: "idle",
        installedVersion: "1.0.0",
        canRemove: true,
      });
      expect((yield* second.resolve("fake-agent"))?.entry).toBe("agent.exe");
    }),
  );

  it.effect("treats a damaged record or a missing program as not installed", () =>
    Effect.gen(function* () {
      const archive = agentZip();
      const { installer, fs, path, runtimesRoot } = yield* makeHarness({
        serve: archiveRoute(archive),
      });
      yield* installer.start({ agent: binaryAgent({ archive }) });
      yield* finished(installer, "fake-agent");
      const directory = path.join(runtimesRoot, "fake-agent", "1.0.0");
      yield* fs.remove(path.join(directory, "agent.exe"));
      expect(yield* installer.resolve("fake-agent")).toBeNull();
      yield* fs.writeFileString(path.join(directory, ".install-complete.json"), "{not json", {
        flag: "w",
      });
      expect(yield* installer.resolve("fake-agent")).toBeNull();
    }),
  );

  it.effect("refuses unsafe provider ids and versions before touching the disk", () =>
    Effect.gen(function* () {
      const { installer, fs, runtimesRoot, requests } = yield* makeHarness({
        serve: archiveRoute(agentZip()),
      });
      for (const agent of [
        binaryAgent({ id: "../escape" }),
        binaryAgent({ id: "ok", version: "../1" }),
        binaryAgent({ id: "a/b" }),
      ]) {
        const exit = yield* Effect.exit(installer.start({ agent }));
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(Exit.isFailure(yield* Effect.exit(installer.remove("../x")))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(installer.goBack("..")))).toBe(true);
      expect(yield* installer.resolve("..")).toBeNull();
      expect(yield* fs.exists(runtimesRoot)).toBe(false);
      expect(requests).toEqual([]);
    }),
  );

  it.effect("never puts the download URL in a failure the phone can read", () =>
    Effect.gen(function* () {
      const { installer } = yield* makeHarness({ serve: () => ({ status: 500 }) });
      yield* installer.start({ agent: binaryAgent() });
      const done = yield* finished(installer, "fake-agent");
      const shown = `${done.message ?? ""} ${done.failure?.detail ?? ""} ${done.failure?.host ?? ""}`;
      expect(shown).not.toContain("https://");
      expect(shown).not.toContain("fake-agent-1.0.0.zip");
    }),
  );
});

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

/**
 * A stand-in for `npm-cli.js`. It records its arguments and environment names,
 * then lays out what `npm install <pkg>@<version>` would: the package, a lock
 * file with an integrity hash, and a program. `BEHAVIOR` picks a failure.
 */
const fakeNpm = (behavior: string) => `
const behavior = ${Schema.encodeSync(Schema.fromJsonString(Schema.String))(behavior)};
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), "npm-call.json"), JSON.stringify({ args, envNames: Object.keys(process.env) }));
const spec = args[1];
const at = spec.lastIndexOf("@");
const name = spec.slice(0, at);
const version = spec.slice(at + 1);
if (behavior === "fail") { console.error("npm error code ETIMEDOUT"); console.error("npm error network request failed"); process.exit(1); }
const dir = path.join(process.cwd(), "node_modules", ...name.split("/"));
fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
const installedVersion = behavior === "wrong-version" ? "9.9.9" : version;
const bin = behavior === "no-bin" ? undefined : { [name.split("/").pop()]: "./bin/cli.js" };
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: installedVersion, bin }));
if (behavior !== "no-bin") fs.writeFileSync(path.join(dir, "bin", "cli.js"), "#!/usr/bin/env node\\nconsole.log('hi');\\n");
const lock = { packages: { ["node_modules/" + name]: behavior === "no-integrity"
  ? { version, resolved: "https://registry.npmjs.org/" + name + "/-/pkg-" + version + ".tgz" }
  : behavior === "other-registry"
    ? { version, resolved: "https://evil.example/pkg.tgz", integrity: "sha512-abc" }
    : { version, resolved: "https://registry.npmjs.org/" + name + "/-/pkg-" + version + ".tgz", integrity: "sha512-AAAA" } } };
fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify(lock));
`;

const NpmCall = Schema.Struct({
  args: Schema.Array(Schema.String),
  envNames: Schema.Array(Schema.String),
});

const npmAgent = (version = "2.5.0", name = "@scope/fake-cli"): RegistryAgent => ({
  id: "npm-agent",
  name: "npm agent",
  version,
  description: "",
  repository: null,
  website: null,
  authors: [],
  license: "MIT",
  licenseUrl: null,
  icon: null,
  binary: {},
  npm: {
    spec: `${name}@${version}`,
    name,
    version,
    args: ["--acp"],
    env: { NPM_AGENT_FLAG: "yes" },
  },
  uvx: null,
});

const makeNpmHarness = (behavior: string, extra: Partial<HarnessOptions> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tools = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-npm-tools-" });
    const cliPath = path.join(tools, "npm-cli.js");
    yield* fs.writeFileString(cliPath, fakeNpm(behavior));
    const harness = yield* makeHarness({
      environment: { ...process.env, SECRET_TOKEN: "do-not-leak" },
      npm: { nodePath: process.execPath, cliPath, cacheDirectory: path.join(tools, "cache") },
      ...extra,
    });
    return harness;
  });

it.layer(NodeServices.layer)("catalog installer: npm packages", (it) => {
  it.effect(
    "installs the exact pinned version with scripts allowed, checks integrity, launches with node",
    () =>
      Effect.gen(function* () {
        const { installer, fs, path, runtimesRoot, spawns } = yield* makeNpmHarness("ok");
        const settled = yield* recordPhases(installer, "npm-agent");
        yield* installer.start({ agent: npmAgent() });
        const done = yield* finished(installer, "npm-agent");
        expect(done).toMatchObject({
          phase: "succeeded",
          installedVersion: "2.5.0",
          totalBytes: null,
        });
        expect(yield* settled).toEqual([
          "idle",
          "resolving",
          "downloading",
          "verifying",
          "starting",
          "succeeded",
        ]);
        const directory = path.join(runtimesRoot, "npm-agent", "2.5.0");
        const call = yield* fs
          .readFileString(path.join(directory, "npm-call.json"))
          .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NpmCall))));
        expect(call.args.slice(0, 2)).toEqual(["install", "@scope/fake-cli@2.5.0"]);
        expect(call.args).toEqual(
          expect.arrayContaining([
            "--save-exact",
            "--ignore-scripts=false",
            "--no-audit",
            "--no-fund",
            "--registry=https://registry.npmjs.org/",
          ]),
        );
        expect(call.args.some((arg) => arg.startsWith("--userconfig="))).toBe(true);
        expect(call.args.some((arg) => arg.startsWith("--globalconfig="))).toBe(true);
        // npm never sees the server's secrets.
        expect(call.envNames).not.toContain("SECRET_TOKEN");

        const resolved = yield* installer.resolve("npm-agent");
        expect(resolved).toMatchObject({
          kind: "npm",
          runner: "node",
          entry: "node_modules/@scope/fake-cli/bin/cli.js",
          args: ["--acp"],
          env: { NPM_AGENT_FLAG: "yes" },
        });
        expect(spawns[0]).toMatchObject({
          command: process.execPath,
          args: [
            path.join(directory, "node_modules", "@scope", "fake-cli", "bin", "cli.js"),
            "--acp",
          ],
          cwd: directory,
        });
        expect(spawns[0]?.env).not.toHaveProperty("SECRET_TOKEN");
      }),
  );

  it.effect("reports an npm failure with npm's own error code", () =>
    Effect.gen(function* () {
      const { installer, fs, path, runtimesRoot } = yield* makeNpmHarness("fail");
      yield* installer.start({ agent: npmAgent() });
      const done = yield* finished(installer, "npm-agent");
      expect(done.failure).toEqual({ kind: "npm", detail: "ETIMEDOUT" });
      expect(yield* dirNames(fs, path.join(runtimesRoot, "npm-agent"))).toEqual([]);
    }),
  );

  it.effect(
    "fails when npm records no integrity hash, or takes the package from another registry",
    () =>
      Effect.gen(function* () {
        for (const behavior of ["no-integrity", "other-registry"]) {
          const { installer } = yield* makeNpmHarness(behavior);
          yield* installer.start({ agent: npmAgent() });
          const done = yield* finished(installer, "npm-agent");
          expect(done.failure?.kind, behavior).toBe("checksum");
        }
      }),
  );

  it.effect("fails when npm installed another version, or the package has no program", () =>
    Effect.gen(function* () {
      for (const behavior of ["wrong-version", "no-bin"]) {
        const { installer, spawns } = yield* makeNpmHarness(behavior);
        yield* installer.start({ agent: npmAgent() });
        const done = yield* finished(installer, "npm-agent");
        expect(done.failure?.kind, behavior).toBe("wontStart");
        expect(spawns, behavior).toEqual([]);
      }
    }),
  );

  it.effect("fails with unsupported, and downloads nothing, when no Node.js can be found", () =>
    Effect.gen(function* () {
      const { installer, requests } = yield* makeHarness({ npm: { nodePath: null } });
      yield* installer.start({ agent: npmAgent() });
      const done = yield* finished(installer, "npm-agent");
      expect(done.failure).toMatchObject({
        kind: "unsupported",
        detail: "It needs Node.js, which isn't on this laptop.",
      });
      expect(requests).toEqual([]);
    }),
  );
});
