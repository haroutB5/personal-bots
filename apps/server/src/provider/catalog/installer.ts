// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or free-space query.
/**
 * Installs registry agents into `<runtimesRoot>/<catalogId>/<version>/`.
 *
 * Generalised from `AntigravityInstallation`: one download at a time, a
 * streamed download with a size cap, a SHA-256 check before anything is
 * unpacked, bounded extraction, a launch check (ACP `initialize`), a pointer
 * file as the commit, lock-tolerant cleanup, and exactly one previous
 * version kept for Go back.
 *
 *  - binary: HTTPS download of the registry archive, sha256 must match.
 *  - npm: `npm install <name>@<exact version>` into the folder; npm's own
 *    integrity check applies and the recorded integrity must exist.
 *
 * Nothing here knows about the live data root: the caller passes the folder.
 * Nothing is logged with a URL, a token or a code; failures log the host.
 *
 * @module provider/catalog/installer
 */
import type {
  ProviderCatalogInstallState,
  ProviderCatalogInstallPhase,
  ProviderInstallFailure,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { terminateDescendants } from "../processTree.ts";
import { runAcpInitializeSmoke, type AcpSmoke, type AcpSmokeResult } from "./acpSmoke.ts";
import {
  ArchiveError,
  extractLimitsFor,
  extractTarGz,
  extractZip,
  placeRawFile,
} from "./archive.ts";
import {
  CatalogInstallError,
  firstSafeLine,
  installError,
  isCatalogInstallError,
  redactUrls,
  toInstallFailure,
} from "./errors.ts";
import {
  minimalEnvironment,
  resolveNodePath,
  resolveNpmCli,
  toSpawnInput,
  type InstalledLaunch,
} from "./launch.ts";
import type { CatalogOverlayEntry } from "./overlay.ts";
import {
  normalizeRelativeCommand,
  resolveInstallPlan,
  type BinaryInstallPlan,
  type NpmInstallPlan,
} from "./plan.ts";
import {
  isSafeCatalogId,
  isSafeVersion,
  registryPlatformKey,
  type RegistryAgent,
  type RegistryPlatform,
} from "./registry.ts";
import { headSize, openHttps, type TransportOptions } from "./transport.ts";

const DOWNLOAD_TIMEOUT = "45 minutes";
const NPM_TIMEOUT = "15 minutes";
const PROGRESS_INTERVAL_MS = 250;
/** Free space needed is this many times the download: the archive plus its unpacked copy plus slack. */
export const DISK_SAFETY_FACTOR = 2.5;
/** When the size is unknown, ask for room for a large agent. */
const UNKNOWN_BINARY_REQUIRED_BYTES = 1536 * 1024 * 1024;
const NPM_REQUIRED_BYTES = 600 * 1024 * 1024;
const HARD_DOWNLOAD_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const RECORD_FILE = ".install-complete.json";
const ACTIVE_FILE = "active.json";
const DOWNLOAD_FILE = ".download.tmp";
const RECORD_MAX_BYTES = 64 * 1024;
const NPM_REGISTRY = "https://registry.npmjs.org/";
const PUBLISH_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const InstallRecord = Schema.Struct({
  schema: Schema.Literal(1),
  catalogId: Schema.String,
  version: Schema.String,
  kind: Schema.Literals(["binary", "npm"]),
  platform: Schema.String,
  installedAtMs: Schema.Number,
  runner: Schema.Literals(["native", "node"]),
  entry: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  archive: Schema.NullOr(
    Schema.Struct({
      sha256: Sha256Hex,
      sha256Source: Schema.Literals(["registry", "overlay"]),
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
type InstallRecord = typeof InstallRecord.Type;

const ActivePointer = Schema.Struct({
  schema: Schema.Literal(1),
  version: Schema.String,
  previousVersion: Schema.NullOr(Schema.String),
});
type ActivePointer = typeof ActivePointer.Type;

const encodeManifest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.String, private: Schema.Boolean, version: Schema.String }),
  ),
);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstallRecord));
const encodePointer = Schema.encodeEffect(Schema.fromJsonString(ActivePointer));

/** A registry agent that is installed and complete. */
export interface InstalledAgent extends InstalledLaunch {
  readonly catalogId: string;
  readonly version: string;
  readonly kind: "binary" | "npm";
  readonly previousVersion: string | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly authMethods: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export interface CatalogInstallRequest {
  readonly agent: RegistryAgent;
  readonly overlay?: CatalogOverlayEntry | undefined;
}

export interface CatalogInstallerOptions {
  /** `%USERPROFILE%\.personal-bots\runtimes\acp` in production; a temp folder in tests. */
  readonly runtimesRoot: string;
  /** Registry platform key. Default: this machine's. */
  readonly platform?: RegistryPlatform | null;
  /** Launch check. Default: start the agent and send ACP `initialize`. */
  readonly smoke?: AcpSmoke;
  readonly transport?: TransportOptions;
  readonly npm?: {
    /** Node.js to run npm and npm agents. Null means there is none. */
    readonly nodePath?: string | null;
    readonly cliPath?: string;
    /** npm cache folder. Default: npm's own. Tests use a temp folder. */
    readonly cacheDirectory?: string;
    readonly registryUrl?: string;
  };
  /** Free bytes on the volume holding `directory`. Default: the real figure. */
  readonly freeBytes?: (directory: string) => Effect.Effect<number | null>;
}

interface CatalogInstallerService {
  readonly runtimesRoot: string;
  /** Number of bytes of free space the install of `request` needs, when the size is known. */
  readonly state: (catalogId: string) => Effect.Effect<ProviderCatalogInstallState>;
  readonly changes: (catalogId: string) => Stream.Stream<ProviderCatalogInstallState>;
  readonly start: (
    request: CatalogInstallRequest,
  ) => Effect.Effect<ProviderCatalogInstallState, CatalogInstallError>;
  readonly cancel: (
    catalogId: string,
    operationId: string,
  ) => Effect.Effect<ProviderCatalogInstallState, CatalogInstallError>;
  /** The active version, or null when nothing complete is installed. */
  readonly resolve: (catalogId: string) => Effect.Effect<InstalledAgent | null>;
  /** Like `resolve`, and holds the lease until the scope closes so Remove and prune wait. */
  readonly acquire: (
    catalogId: string,
  ) => Effect.Effect<InstalledAgent, CatalogInstallError, Scope.Scope>;
  readonly goBack: (catalogId: string) => Effect.Effect<InstalledAgent, CatalogInstallError>;
  readonly remove: (catalogId: string) => Effect.Effect<void, CatalogInstallError>;
}

export class CatalogInstaller extends Context.Service<CatalogInstaller, CatalogInstallerService>()(
  "t3/provider/catalog/installer/CatalogInstaller",
) {}

const isRunning = (state: ProviderCatalogInstallState) =>
  state.phase === "resolving" ||
  state.phase === "downloading" ||
  state.phase === "verifying" ||
  state.phase === "extracting" ||
  state.phase === "starting";

const idleState = (catalogId: string): ProviderCatalogInstallState => ({
  catalogId,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  previousVersion: null,
  canRemove: false,
  message: null,
  failure: null,
});

const hostOfUrl = (value: string): string => {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
};

/** Disk errors read as a disk failure whatever layer reported them. */
function isNoSpace(cause: unknown): boolean {
  const text = String((cause as { message?: unknown } | null)?.message ?? cause);
  return /ENOSPC|no space left|not enough space|disk full/iu.test(text);
}

/** Passes an install error through; a full disk reads as disk, anything else as the fallback sentence. */
const toInstallError =
  (fallback: string) =>
  (cause: unknown): CatalogInstallError =>
    isCatalogInstallError(cause)
      ? cause
      : isNoSpace(cause)
        ? installError("disk", "The laptop ran out of space.", { cause })
        : installError("other", fallback, { cause });

const logFailure = (catalogId: string, cause: Cause.Cause<CatalogInstallError>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  return Effect.logWarning("Provider install failed", {
    catalogId,
    kind: failure?.kind ?? "unknown",
    detail: failure === undefined ? "no error value" : firstSafeLine(failure.detail),
    host: failure?.host,
    cause: redactUrls(String(failure?.cause ?? Cause.pretty(cause))).slice(0, 1_000),
  });
};

export const makeCatalogInstaller = Effect.fn("CatalogInstaller.make")(function* (
  options: CatalogInstallerOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArch = yield* HostProcessArchitecture;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform =
    options.platform === undefined ? registryPlatformKey(hostPlatform, hostArch) : options.platform;
  const smoke = options.smoke ?? runAcpInitializeSmoke;
  const transport = options.transport ?? {};
  const root = options.runtimesRoot;

  const findNode = resolveNodePath(hostEnvironment).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  /** The Node.js to use: the option when given (null = none), else the one on this machine. */
  const nodeOf = Effect.suspend(() =>
    options.npm?.nodePath === undefined ? findNode : Effect.succeed(options.npm.nodePath),
  );
  const findNpmCli = (nodePath: string) =>
    resolveNpmCli(nodePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const stateGate = yield* Semaphore.make(1);
  /** One download or npm install at a time on this laptop. */
  const installGate = yield* Semaphore.make(1);
  const states = new Map<string, SubscriptionRef.SubscriptionRef<ProviderCatalogInstallState>>();
  const running = new Map<
    string,
    { readonly operationId: string; readonly fiber: Fiber.Fiber<void> }
  >();
  const leases = new Map<string, number>();
  const inProgress = new Set<string>();

  const agentDirectory = (catalogId: string) => path.join(root, catalogId);
  const versionDirectory = (catalogId: string, version: string) =>
    path.join(root, catalogId, version);
  const pointerPath = (catalogId: string) => path.join(root, catalogId, ACTIVE_FILE);

  const requireSafe = (catalogId: string, version?: string) =>
    isSafeCatalogId(catalogId) && (version === undefined || isSafeVersion(version))
      ? Effect.void
      : Effect.fail(installError("other", "That provider has an unsafe name."));

  const retryThroughLocks = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      for (const delay of PUBLISH_RETRY_DELAYS_MS) {
        const exit = yield* Effect.exit(self);
        if (Exit.isSuccess(exit)) return exit.value;
        yield* Effect.sleep(delay);
      }
      return yield* self;
    });

  const removeTree = (directory: string) =>
    retryThroughLocks(fs.remove(directory, { recursive: true, force: true }));

  const readJson = Effect.fn("CatalogInstaller.readJson")(function* <A>(
    filePath: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(filePath);
    if (info.type !== "File" || Number(info.size) > RECORD_MAX_BYTES) {
      return yield* installError("other", "An install record is invalid.");
    }
    const contents = yield* fs.readFileString(filePath);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents);
  });

  const fileExists = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  /** A complete, self-consistent version folder, or null. */
  const loadVersion = Effect.fn("CatalogInstaller.loadVersion")(function* (
    catalogId: string,
    version: string,
    previousVersion: string | null,
  ) {
    if (!isSafeCatalogId(catalogId) || !isSafeVersion(version)) return null;
    const directory = versionDirectory(catalogId, version);
    const record = yield* readJson(path.join(directory, RECORD_FILE), InstallRecord).pipe(
      Effect.option,
    );
    if (Option.isNone(record)) return null;
    const value = record.value;
    const entry = normalizeRelativeCommand(value.entry);
    if (
      value.catalogId !== catalogId ||
      value.version !== version ||
      entry === null ||
      entry !== value.entry ||
      !(yield* fileExists(path.join(directory, ...entry.split("/"))))
    ) {
      return null;
    }
    return {
      catalogId,
      version,
      kind: value.kind,
      directory,
      runner: value.runner,
      entry,
      args: value.args,
      env: value.env,
      previousVersion,
      agentName: value.agentName,
      agentVersion: value.agentVersion,
      authMethods: [],
    } satisfies InstalledAgent;
  });

  const readPointer = (catalogId: string) =>
    readJson(pointerPath(catalogId), ActivePointer).pipe(Effect.option);

  const resolve = Effect.fn("CatalogInstaller.resolve")(function* (catalogId: string) {
    if (!isSafeCatalogId(catalogId)) return null;
    const pointer = yield* readPointer(catalogId);
    if (Option.isNone(pointer)) return null;
    return yield* loadVersion(catalogId, pointer.value.version, pointer.value.previousVersion);
  });

  const stateRef = (catalogId: string) =>
    stateGate.withPermit(
      Effect.gen(function* () {
        const existing = states.get(catalogId);
        if (existing !== undefined) return existing;
        const installed = isSafeCatalogId(catalogId) ? yield* resolve(catalogId) : null;
        const ref = yield* SubscriptionRef.make<ProviderCatalogInstallState>({
          ...idleState(catalogId),
          installedVersion: installed?.version ?? null,
          previousVersion: installed?.previousVersion ?? null,
          canRemove: installed !== null,
        });
        states.set(catalogId, ref);
        return ref;
      }),
    );

  const report = (
    catalogId: string,
    patch: Partial<ProviderCatalogInstallState>,
    operationId?: string,
  ) =>
    stateRef(catalogId).pipe(
      Effect.flatMap((ref) =>
        SubscriptionRef.update(ref, (current) =>
          operationId !== undefined && current.operationId !== operationId
            ? current
            : { ...current, ...patch },
        ),
      ),
    );

  /** A late failure (an interrupt after the commit) never overwrites a finished install. */
  const reportWhileRunning = (
    catalogId: string,
    patch: Partial<ProviderCatalogInstallState>,
    operationId: string,
  ) =>
    stateRef(catalogId).pipe(
      Effect.flatMap((ref) =>
        SubscriptionRef.update(ref, (current) =>
          current.operationId === operationId && isRunning(current)
            ? { ...current, ...patch }
            : current,
        ),
      ),
    );

  const phase = (
    catalogId: string,
    operationId: string,
    next: ProviderCatalogInstallPhase,
    message: string | null,
  ) => report(catalogId, { phase: next, message }, operationId);

  // ---------------------------------------------------------------------
  // disk
  // ---------------------------------------------------------------------

  const defaultFreeBytes = (directory: string) =>
    Effect.tryPromise(() => NodeFSP.statfs(directory, { bigint: true })).pipe(
      Effect.map((stats) => {
        const free = stats.bavail * stats.bsize;
        return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
      }),
      Effect.orElseSucceed(() => null),
    );
  const freeBytesOf = options.freeBytes ?? defaultFreeBytes;

  /** Refuses before any byte is downloaded when the volume is too full. */
  const ensureRoom = Effect.fn("CatalogInstaller.ensureRoom")(function* (
    directory: string,
    requiredBytes: number,
  ) {
    const free = yield* freeBytesOf(directory);
    if (free !== null && free < requiredBytes) {
      return yield* installError("disk", "There is not enough free space on this laptop.", {
        neededBytes: requiredBytes,
        freeBytes: free,
      });
    }
  });

  // ---------------------------------------------------------------------
  // download (binary)
  // ---------------------------------------------------------------------

  const downloadArchive = Effect.fn("CatalogInstaller.downloadArchive")(function* (
    catalogId: string,
    operationId: string,
    plan: BinaryInstallPlan,
    destination: string,
    headBytes: number | null,
  ) {
    const { response, host } = yield* openHttps(http, { url: plan.url }, transport);
    const declared = Number(response.headers["content-length"]);
    const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
    const identity = encoding === undefined || encoding === "" || encoding === "identity";
    const declaredBytes =
      identity && Number.isSafeInteger(declared) && declared > 0 ? declared : null;
    const total = declaredBytes ?? headBytes;
    const cap = Math.min(
      HARD_DOWNLOAD_CAP_BYTES,
      declaredBytes ?? headBytes ?? HARD_DOWNLOAD_CAP_BYTES,
    );
    yield* report(catalogId, { totalBytes: total, downloadedBytes: 0 }, operationId);
    const hash = NodeCrypto.createHash("sha256");
    let downloaded = 0;
    let lastProgressAt = yield* Clock.currentTimeMillis;
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          downloaded += chunk.byteLength;
          if (downloaded > cap) {
            return yield* installError("network", `${host} sent more data than expected.`, {
              host,
            });
          }
          hash.update(chunk);
          const now = yield* Clock.currentTimeMillis;
          if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = now;
            yield* report(catalogId, { downloadedBytes: downloaded }, operationId);
          }
        }),
      ),
      Stream.run(fs.sink(destination, { flag: "wx", mode: 0o600 })),
      Effect.timeoutOrElse({
        duration: DOWNLOAD_TIMEOUT,
        orElse: () =>
          Effect.fail(
            installError("network", `The download from ${host} took too long.`, { host }),
          ),
      }),
      Effect.mapError((cause) =>
        isCatalogInstallError(cause)
          ? cause
          : isNoSpace(cause)
            ? installError("disk", "The laptop ran out of space during the download.", { cause })
            : installError("network", `The connection to ${host} was interrupted.`, {
                host,
                cause,
              }),
      ),
    );
    yield* report(catalogId, { downloadedBytes: downloaded }, operationId);
    if (declaredBytes !== null && downloaded !== declaredBytes) {
      return yield* installError("network", `The connection to ${host} was interrupted.`, { host });
    }
    return { sha256: hash.digest("hex"), bytes: downloaded, host };
  });

  const unpack = (
    plan: BinaryInstallPlan,
    archivePath: string,
    directory: string,
    archiveBytes: number,
  ) =>
    Effect.tryPromise({
      try: (signal) => {
        const limits = extractLimitsFor(archiveBytes);
        switch (plan.format) {
          case "zip":
            return extractZip(archivePath, directory, limits, signal);
          case "tar.gz":
            return extractTarGz(archivePath, directory, limits, signal);
          case "raw":
            return placeRawFile(archivePath, directory, plan.command, limits);
        }
      },
      catch: (cause) =>
        isNoSpace(cause)
          ? installError("disk", "The laptop ran out of space while unpacking.", { cause })
          : installError(
              "other",
              cause instanceof ArchiveError
                ? `The download could not be unpacked. ${cause.message}`
                : "The download could not be unpacked.",
              { cause },
            ),
    });

  // ---------------------------------------------------------------------
  // npm
  // ---------------------------------------------------------------------

  const collectOutput = (stream: Stream.Stream<Uint8Array, unknown>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (text: string, chunk: string) => (text + chunk).slice(-16_384),
      ),
      Effect.orElseSucceed(() => ""),
    );

  const npmFailure = (name: string, output: string, cause?: unknown) => {
    const code =
      /npm (?:error|ERR!) code ([A-Z0-9_]+)/u.exec(output)?.[1] ??
      /\b(E[A-Z]{3,}[A-Z0-9_]*)\b/u.exec(output)?.[1];
    return installError(
      "npm",
      code ??
        firstSafeLine(
          output
            .split(/\r?\n/u)
            .filter((line) => /npm (?:error|ERR!)/u.test(line))
            .join("\n"),
        ) ??
        `npm could not get ${name}.`,
      cause === undefined ? {} : { cause },
    );
  };

  const runNpmInstall = Effect.fn("CatalogInstaller.runNpmInstall")(function* (
    plan: NpmInstallPlan,
    directory: string,
  ) {
    const nodePath = yield* nodeOf;
    if (nodePath === null) {
      return yield* installError("unsupported", "Node.js is not installed on this laptop.");
    }
    const cliPath = options.npm?.cliPath ?? (yield* findNpmCli(nodePath));
    if (cliPath === null) {
      return yield* installError(
        "unsupported",
        "npm was not found next to Node.js on this laptop.",
      );
    }
    const emptyConfig = path.join(directory, ".npmrc-empty");
    yield* fs.writeFileString(emptyConfig, "", { flag: "wx", mode: 0o600 });
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      yield* encodeManifest({
        name: `hbots-agent-${plan.name.replace(/[@/]/gu, "-")}`,
        private: true,
        version: "0.0.0",
      }),
      { flag: "wx", mode: 0o600 },
    );
    const args = [
      cliPath,
      "install",
      `${plan.name}@${plan.version}`,
      "--save-exact",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      "--no-progress",
      "--loglevel=error",
      `--registry=${options.npm?.registryUrl ?? NPM_REGISTRY}`,
      `--userconfig=${emptyConfig}`,
      `--globalconfig=${emptyConfig}`,
      ...(options.npm?.cacheDirectory === undefined
        ? []
        : [`--cache=${options.npm.cacheDirectory}`]),
    ];
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(nodePath, args, {
            cwd: directory,
            env: minimalEnvironment(hostEnvironment),
            extendEnv: false,
            shell: false,
          }),
        );
        yield* Effect.addFinalizer(() =>
          terminateDescendants(Number(child.pid)).pipe(
            Effect.andThen(child.kill().pipe(Effect.ignore)),
          ),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collectOutput(child.stdout), collectOutput(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { output: `${stderr}\n${stdout}`, exitCode: Number(exitCode) };
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: NPM_TIMEOUT,
        orElse: () => Effect.fail(installError("npm", "ETIMEDOUT")),
      }),
      Effect.mapError((cause) =>
        isCatalogInstallError(cause)
          ? cause
          : installError("npm", `npm could not run for ${plan.name}.`, { cause }),
      ),
    );
    if (result.exitCode !== 0) {
      return yield* npmFailure(plan.name, result.output);
    }
  });

  const NpmPackageJson = Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    bin: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
    ),
  });
  const NpmLock = Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.Struct({
        version: Schema.optionalKey(Schema.String),
        resolved: Schema.optionalKey(Schema.String),
        integrity: Schema.optionalKey(Schema.String),
      }),
    ),
  });

  /** The installed package must be the pinned one, with an integrity hash from the registry. */
  const verifyNpmInstall = Effect.fn("CatalogInstaller.verifyNpmInstall")(function* (
    plan: NpmInstallPlan,
    directory: string,
  ) {
    const packageDirectory = path.join(directory, "node_modules", ...plan.name.split("/"));
    const manifest = yield* fs.readFileString(path.join(packageDirectory, "package.json")).pipe(
      Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(NpmPackageJson))(text)),
      Effect.mapError((cause) =>
        installError("wontStart", `npm did not install ${plan.name}.`, { cause }),
      ),
    );
    if (manifest.name !== plan.name || manifest.version !== plan.version) {
      return yield* installError("wontStart", `npm installed a different version of ${plan.name}.`);
    }
    const lock = yield* fs.readFileString(path.join(directory, "package-lock.json")).pipe(
      Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(NpmLock))(text)),
      Effect.mapError((cause) =>
        installError("checksum", "npm did not record an integrity hash.", { cause }),
      ),
    );
    const locked = lock.packages[`node_modules/${plan.name}`];
    const registryHost = hostOfUrl(locked?.resolved ?? "");
    const expectedHost = hostOfUrl(options.npm?.registryUrl ?? NPM_REGISTRY);
    if (
      locked?.version !== plan.version ||
      locked.integrity === undefined ||
      !/^sha(?:256|384|512)-/u.test(locked.integrity) ||
      registryHost !== expectedHost
    ) {
      return yield* installError("checksum", "npm did not record an integrity hash for it.");
    }
    // `npx <pkg>` runs the one bin, or the bin named like the package.
    const unscoped = plan.name.split("/").pop()!;
    const bins =
      manifest.bin === undefined
        ? {}
        : typeof manifest.bin === "string"
          ? { [unscoped]: manifest.bin }
          : manifest.bin;
    const names = Object.keys(bins);
    const chosen =
      names.length === 1 ? names[0] : names.find((candidate) => candidate === unscoped);
    const binPath = chosen === undefined ? null : normalizeRelativeCommand(bins[chosen]!);
    if (binPath === null) {
      return yield* installError("wontStart", `${plan.name} does not say which program to start.`);
    }
    const entry = ["node_modules", ...plan.name.split("/"), binPath].join("/");
    const entryPath = path.join(directory, ...entry.split("/"));
    if (!(yield* fileExists(entryPath))) {
      return yield* installError(
        "wontStart",
        `${plan.name} does not contain the program it names.`,
      );
    }
    const head = yield* Effect.tryPromise(async () => {
      const handle = await NodeFSP.open(entryPath, "r");
      try {
        const buffer = Buffer.alloc(128);
        const { bytesRead } = await handle.read(buffer, 0, 128, 0);
        return buffer.subarray(0, bytesRead).toString("latin1");
      } finally {
        await handle.close();
      }
    }).pipe(Effect.orElseSucceed(() => ""));
    const runner =
      /\.(?:c|m)?js$/iu.test(binPath) ||
      (head.startsWith("#!") && /node/u.test(head.split("\n")[0]!))
        ? ("node" as const)
        : ("native" as const);
    return {
      entry,
      runner,
      integrity: locked.integrity,
      registryHost,
    };
  });

  // ---------------------------------------------------------------------
  // install
  // ---------------------------------------------------------------------

  const activate = Effect.fn("CatalogInstaller.activate")(function* (
    catalogId: string,
    version: string,
  ) {
    const existing = yield* readPointer(catalogId);
    const previous =
      Option.isSome(existing) && existing.value.version !== version
        ? existing.value.version
        : Option.isSome(existing)
          ? existing.value.previousVersion
          : null;
    const directory = agentDirectory(catalogId);
    const suffix = (yield* crypto.randomUUIDv4).slice(0, 8);
    const temporary = path.join(directory, `${ACTIVE_FILE}.${suffix}.tmp`);
    yield* fs.writeFileString(
      temporary,
      yield* encodePointer({ schema: 1, version, previousVersion: previous }),
      { flag: "wx", mode: 0o600 },
    );
    // The pointer is the commit: rename is atomic, and anything after it only tidies up.
    yield* retryThroughLocks(fs.rename(temporary, pointerPath(catalogId)));
    return previous;
  });

  /** Removes every version folder except the active one and the one kept for Go back. */
  const prune = Effect.fn("CatalogInstaller.prune")(function* (
    catalogId: string,
    keep: ReadonlyArray<string>,
  ) {
    const directory = agentDirectory(catalogId);
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    for (const name of names) {
      if (name === ACTIVE_FILE || keep.includes(name)) continue;
      const target = path.join(directory, name);
      if (inProgress.has(target) || (leases.get(target) ?? 0) > 0) continue;
      if (name.endsWith(".tmp") || name.startsWith(".")) {
        yield* removeTree(target).pipe(Effect.ignore);
        continue;
      }
      yield* removeTree(target).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Provider install could not remove an old version", {
            catalogId,
            version: name,
            cause: redactUrls(String(cause)).slice(0, 300),
          }),
        ),
      );
    }
  });

  const launchOf = (
    directory: string,
    runner: "native" | "node",
    entry: string,
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string>>,
  ): InstalledLaunch => ({ directory, runner, entry, args, env });

  const runSmoke = Effect.fn("CatalogInstaller.runSmoke")(function* (launch: InstalledLaunch) {
    const nodePath = launch.runner === "node" ? yield* nodeOf : null;
    const spawn = toSpawnInput(launch, { nodePath, hostEnvironment }, path.join);
    if (spawn === null) {
      return yield* installError("unsupported", "Node.js is not installed on this laptop.");
    }
    return yield* smoke(spawn).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  });

  const writeRecord = Effect.fn("CatalogInstaller.writeRecord")(function* (
    directory: string,
    record: InstallRecord,
  ) {
    yield* fs.writeFileString(path.join(directory, RECORD_FILE), yield* encodeRecord(record), {
      flag: "wx",
      mode: 0o600,
    });
  });

  const installAgent = Effect.fn("CatalogInstaller.install")(function* (
    request: CatalogInstallRequest,
    operationId: string,
  ) {
    const { agent } = request;
    const catalogId = agent.id;
    yield* requireSafe(catalogId, agent.version);
    yield* phase(catalogId, operationId, "resolving", "Waiting for another install to finish.");
    yield* installGate.withPermit(
      Effect.gen(function* () {
        yield* phase(catalogId, operationId, "resolving", "Checking what to download.");
        const nodeAvailable = (yield* nodeOf) !== null;
        const plan = resolveInstallPlan(agent, {
          platform,
          nodeAvailable,
          overlay: request.overlay,
        });
        if (plan.kind === "unsupported") {
          return yield* installError(
            "unsupported",
            plan.reason === "needsUv"
              ? "It needs uv, a Python tool that isn't on this laptop."
              : plan.reason === "noChecksum"
                ? "The registry lists no fingerprint for this download, so hbots won't install it."
                : plan.reason === "needsNode"
                  ? "It needs Node.js, which isn't on this laptop."
                  : plan.reason === "noWindowsBuild"
                    ? "There is no build of it for this laptop."
                    : "hbots can't install this one from the registry entry.",
          );
        }
        const agentDir = agentDirectory(catalogId);
        const directory = versionDirectory(catalogId, agent.version);
        yield* report(catalogId, { version: agent.version, failure: null }, operationId);
        yield* fs.makeDirectory(agentDir, { recursive: true });

        // The same version, already complete: check it starts and keep it.
        const existing = yield* loadVersion(catalogId, agent.version, null);
        if (existing !== null) {
          yield* phase(catalogId, operationId, "starting", "Checking it starts.");
          const again = yield* runSmoke(existing).pipe(Effect.option);
          if (Option.isSome(again)) {
            const previous = yield* activate(catalogId, agent.version);
            yield* prune(catalogId, [agent.version, ...(previous === null ? [] : [previous])]);
            yield* report(
              catalogId,
              {
                phase: "succeeded",
                message: null,
                installedVersion: agent.version,
                previousVersion: previous,
                canRemove: true,
              },
              operationId,
            );
            return;
          }
        }

        let headBytes: number | null = null;
        if (plan.kind === "binary") {
          headBytes = yield* headSize(http, plan.url, transport).pipe(
            Effect.timeout("20 seconds"),
            Effect.orElseSucceed(() => null),
          );
        }
        const required =
          plan.kind === "npm"
            ? NPM_REQUIRED_BYTES
            : headBytes === null
              ? UNKNOWN_BINARY_REQUIRED_BYTES
              : Math.ceil(headBytes * DISK_SAFETY_FACTOR);
        yield* ensureRoom(agentDir, required);
        yield* report(catalogId, { totalBytes: headBytes }, operationId);

        // Anything left by an interrupted install holds hundreds of MB.
        yield* prune(catalogId, [
          ...(yield* readPointer(catalogId).pipe(
            Effect.map((pointer) =>
              Option.isSome(pointer)
                ? [
                    pointer.value.version,
                    ...(pointer.value.previousVersion === null
                      ? []
                      : [pointer.value.previousVersion]),
                  ]
                : [],
            ),
          )),
        ]);
        if (yield* fs.exists(directory)) yield* removeTree(directory);
        yield* fs.makeDirectory(directory, { recursive: false });
        inProgress.add(directory);

        const build = Effect.gen(function* () {
          let launch: InstalledLaunch;
          let archive: InstallRecord["archive"] = null;
          let npm: InstallRecord["npm"] = null;
          if (plan.kind === "binary") {
            yield* phase(catalogId, operationId, "downloading", "Downloading.");
            const archivePath = path.join(directory, DOWNLOAD_FILE);
            const downloaded = yield* downloadArchive(
              catalogId,
              operationId,
              plan,
              archivePath,
              headBytes,
            );
            yield* phase(catalogId, operationId, "verifying", "Checking the download.");
            if (downloaded.sha256 !== plan.sha256) {
              yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
              return yield* installError(
                "checksum",
                "It wasn't the file the publisher listed, so it was deleted without running it.",
                { host: downloaded.host },
              );
            }
            yield* phase(catalogId, operationId, "extracting", "Unpacking.");
            yield* unpack(plan, archivePath, directory, downloaded.bytes);
            yield* fs.remove(archivePath, { force: true });
            const entryPath = path.join(directory, ...plan.command.split("/"));
            if (!(yield* fileExists(entryPath))) {
              return yield* installError(
                "wontStart",
                "The download did not contain the program it should start.",
              );
            }
            if (hostPlatform !== "win32") yield* fs.chmod(entryPath, 0o755);
            archive = {
              sha256: plan.sha256,
              sha256Source: plan.sha256Source,
              bytes: downloaded.bytes,
              host: downloaded.host,
            };
            launch = launchOf(directory, "native", plan.command, plan.args, plan.env);
          } else {
            yield* phase(catalogId, operationId, "downloading", "Installing from npm.");
            yield* runNpmInstall(plan, directory);
            yield* phase(catalogId, operationId, "verifying", "Checking the package.");
            const verified = yield* verifyNpmInstall(plan, directory);
            npm = {
              name: plan.name,
              version: plan.version,
              integrity: verified.integrity,
              registryHost: verified.registryHost,
            };
            launch = launchOf(directory, verified.runner, verified.entry, plan.args, plan.env);
          }

          yield* phase(catalogId, operationId, "starting", "Checking it starts.");
          const started: AcpSmokeResult = yield* runSmoke(launch);
          const installedAtMs = yield* Clock.currentTimeMillis;
          yield* writeRecord(directory, {
            schema: 1,
            catalogId,
            version: agent.version,
            kind: plan.kind,
            platform: platform ?? "unknown",
            installedAtMs,
            runner: launch.runner,
            entry: launch.entry,
            args: [...launch.args],
            env: { ...launch.env },
            archive,
            npm,
            agentName: started.agentName,
            agentVersion: started.agentVersion,
            protocolVersion: started.protocolVersion,
          });
        });

        // Cancelled or failed: the partial folder goes and the previous version is
        // untouched. onExit runs its cleanup even when the fiber is interrupted.
        yield* build.pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              inProgress.delete(directory);
              return Exit.isFailure(exit)
                ? removeTree(directory).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Provider install could not clean up", {
                        catalogId,
                        cause: redactUrls(String(cause)).slice(0, 300),
                      }),
                    ),
                  )
                : Effect.void;
            }),
          ),
        );

        // The pointer is the commit. Tidying and the report come after it, in that
        // order, so "succeeded" is only ever seen once the old versions are gone.
        const previous = yield* activate(catalogId, agent.version).pipe(Effect.uninterruptible);
        yield* prune(catalogId, [agent.version, ...(previous === null ? [] : [previous])]).pipe(
          Effect.uninterruptible,
        );
        yield* report(
          catalogId,
          {
            phase: "succeeded",
            message: null,
            installedVersion: agent.version,
            previousVersion: previous,
            canRemove: true,
          },
          operationId,
        );
      }),
    );
  });

  // ---------------------------------------------------------------------
  // service
  // ---------------------------------------------------------------------

  /** What the card shows for a failed or cancelled install. */
  const failureState = (
    cause: Cause.Cause<CatalogInstallError>,
  ): Partial<ProviderCatalogInstallState> => {
    if (Cause.hasInterruptsOnly(cause)) {
      return {
        phase: "cancelled",
        message: "Installation cancelled. The previous version is unchanged.",
        failure: null,
      };
    }
    const error = Cause.findErrorOption(cause);
    const failure: ProviderInstallFailure = Option.isSome(error)
      ? toInstallFailure(error.value)
      : { kind: "other", detail: "Something went wrong while installing." };
    return { phase: "failed", message: failure.detail, failure };
  };

  const start: CatalogInstallerService["start"] = (request) =>
    Effect.gen(function* () {
      const catalogId = request.agent.id;
      yield* requireSafe(catalogId, request.agent.version);
      const ref = yield* stateRef(catalogId);
      const operationId = yield* crypto.randomUUIDv4;
      return yield* stateGate.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(ref);
          if (isRunning(current)) return current;
          const next: ProviderCatalogInstallState = {
            ...current,
            operationId,
            phase: "resolving",
            downloadedBytes: 0,
            totalBytes: null,
            version: request.agent.version,
            message: "Checking what to download.",
            failure: null,
          };
          yield* SubscriptionRef.set(ref, next);
          const work = installAgent(request, operationId).pipe(
            Effect.mapError(
              toInstallError(
                "Could not finish the installation. Check disk space and folder access.",
              ),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.andThen(
                    logFailure(catalogId, exit.cause),
                    reportWhileRunning(catalogId, failureState(exit.cause), operationId),
                  )
                : Effect.void,
            ),
            Effect.ignoreCause,
            Effect.ensuring(
              Effect.sync(() => {
                if (running.get(catalogId)?.operationId === operationId) running.delete(catalogId);
              }),
            ),
          );
          const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
          running.set(catalogId, { operationId, fiber });
          return next;
        }),
      );
    }).pipe(
      Effect.uninterruptible,
      Effect.mapError(toInstallError("Could not start the installation.")),
    );

  const cancel: CatalogInstallerService["cancel"] = (catalogId, operationId) =>
    Effect.gen(function* () {
      const ref = yield* stateRef(catalogId);
      const current = yield* SubscriptionRef.get(ref);
      if (current.operationId !== operationId) {
        return yield* installError("other", "This installation is no longer current.");
      }
      const job = running.get(catalogId);
      if (job?.operationId === operationId && isRunning(current)) {
        yield* Fiber.interrupt(job.fiber);
      }
      return yield* SubscriptionRef.get(ref);
    }).pipe(Effect.mapError(toInstallError("Could not cancel the installation.")));

  const acquire: CatalogInstallerService["acquire"] = (catalogId) =>
    Effect.acquireRelease(
      stateGate.withPermit(
        Effect.gen(function* () {
          const installed = yield* resolve(catalogId);
          if (installed === null) {
            return yield* installError("other", "That provider is not installed.");
          }
          leases.set(installed.directory, (leases.get(installed.directory) ?? 0) + 1);
          return installed;
        }),
      ),
      (installed) =>
        stateGate.withPermit(
          Effect.sync(() => {
            const remaining = (leases.get(installed.directory) ?? 1) - 1;
            if (remaining > 0) leases.set(installed.directory, remaining);
            else leases.delete(installed.directory);
          }),
        ),
    ).pipe(Effect.mapError(toInstallError("That provider is not installed.")));

  const goBack: CatalogInstallerService["goBack"] = (catalogId) =>
    Effect.gen(function* () {
      yield* requireSafe(catalogId);
      const ref = yield* stateRef(catalogId);
      if (isRunning(yield* SubscriptionRef.get(ref))) {
        return yield* installError("other", "Wait for the install to finish first.");
      }
      const pointer = yield* readPointer(catalogId);
      if (Option.isNone(pointer) || pointer.value.previousVersion === null) {
        return yield* installError("other", "There is no earlier version kept.");
      }
      const target = pointer.value.previousVersion;
      const earlier = yield* loadVersion(catalogId, target, pointer.value.version);
      if (earlier === null) {
        return yield* installError("other", "The earlier version is no longer complete on disk.");
      }
      const suffix = (yield* crypto.randomUUIDv4).slice(0, 8);
      const temporary = path.join(agentDirectory(catalogId), `${ACTIVE_FILE}.${suffix}.tmp`);
      yield* fs.writeFileString(
        temporary,
        yield* encodePointer({
          schema: 1,
          version: target,
          previousVersion: pointer.value.version,
        }),
        { flag: "wx", mode: 0o600 },
      );
      yield* retryThroughLocks(fs.rename(temporary, pointerPath(catalogId)));
      yield* SubscriptionRef.update(ref, (current) => ({
        ...current,
        phase: "idle" as const,
        installedVersion: target,
        previousVersion: pointer.value.version,
        failure: null,
        message: null,
      }));
      return earlier;
    }).pipe(Effect.mapError(toInstallError("Could not go back to the earlier version.")));

  const remove: CatalogInstallerService["remove"] = (catalogId) =>
    Effect.gen(function* () {
      yield* requireSafe(catalogId);
      const ref = yield* stateRef(catalogId);
      const directory = agentDirectory(catalogId);
      yield* stateGate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(ref))) {
            return yield* installError(
              "other",
              "Wait for the install to finish before removing it.",
            );
          }
          for (const [leased, count] of leases) {
            if (count > 0 && leased.startsWith(`${directory}${path.sep}`)) {
              return yield* installError(
                "other",
                "Stop its chats before removing it. They are still using it.",
              );
            }
          }
          yield* removeTree(directory);
          yield* SubscriptionRef.set(ref, idleState(catalogId));
        }).pipe(Effect.uninterruptible),
      );
    }).pipe(
      Effect.mapError(
        toInstallError("Could not remove it. Check for open programs and try again."),
      ),
    );

  return CatalogInstaller.of({
    runtimesRoot: root,
    state: (catalogId) => stateRef(catalogId).pipe(Effect.flatMap(SubscriptionRef.get)),
    changes: (catalogId) =>
      Stream.unwrap(stateRef(catalogId).pipe(Effect.map((ref) => SubscriptionRef.changes(ref)))),
    start,
    cancel,
    resolve,
    acquire,
    goBack,
    remove,
  });
});
