/**
 * The provider catalogue service (SPEC 11.1): fetches the ACP registry once a
 * day, keeps the last good copy on disk, probes download sizes, proxies the
 * registry's icons, and lists built-ins plus registry agents.
 *
 * A registry that fails to fetch, is too large, or does not parse leaves the
 * cached copy in place. Nothing is fetched over anything but HTTPS.
 *
 * @module provider/catalog/ProviderCatalog
 */
import type {
  ProviderCatalogInstallPlan,
  ProviderCatalogListInput,
  ProviderCatalogListResult,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";

import {
  BUILT_IN_DESCRIPTORS,
  buildCatalogEntries,
  defaultIconUrlFor,
  downloadLabel,
  registryAgentForCatalogId,
  type BuiltInDescriptor,
} from "./entries.ts";
import { redactUrls } from "./errors.ts";
import { resolveNodePath } from "./launch.ts";
import {
  BUNDLED_CATALOG_OVERLAY,
  newerOverlay,
  parseOverlay,
  parseOverlayText,
  type CatalogOverlay,
  type CatalogOverlayEntry,
} from "./overlay.ts";
import { requiredFreeBytes, resolveInstallPlan, type InstallPlan } from "./plan.ts";
import {
  parseRegistry,
  parseRegistryText,
  REGISTRY_MAX_BYTES,
  REGISTRY_URL,
  registryPlatformKey,
  type ParsedRegistry,
  type RegistryAgent,
  type RegistryPlatform,
} from "./registry.ts";
import { fetchText, headSize, type TransportOptions } from "./transport.ts";
import type { CatalogInstallRequest } from "./installer.ts";

/** A registry copy older than this is stale and refreshed in the background. */
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, wait this long before trying again on its own. */
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT = "10 seconds";
const SIZE_PROBE_TIMEOUT = "15 seconds";
const SIZE_PROBE_CONCURRENCY = 3;
const PROBE_RETRY_MS = 60 * 60 * 1000;
const ICON_MAX_BYTES = 64 * 1024;
const OVERLAY_MAX_BYTES = 512 * 1024;
const CACHE_FILE = "provider-catalog.json";

const CacheFile = Schema.Struct({
  schema: Schema.Literal(1),
  fetchedAtMs: Schema.Number,
  /** The registry document as fetched, decoded again on load so parser fixes apply to old copies. */
  registry: Schema.Unknown,
  /** Archive URL to size in bytes. */
  sizes: Schema.Record(Schema.String, Schema.Number),
  overlay: Schema.optionalKey(Schema.Unknown),
});
type CacheFile = typeof CacheFile.Type;
const decodeCache = Schema.decodeEffect(Schema.fromJsonString(CacheFile));
const decodeJsonDocument = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeCache = Schema.encodeEffect(Schema.fromJsonString(CacheFile));

/**
 * An icon is safe to serve only when it cannot run or load anything. The
 * registry's icons are plain one-colour paths; anything else is dropped
 * instead of "cleaned", so what is served is byte for byte what was reviewed.
 */
export function isSafeSvg(text: string): boolean {
  if (text.length === 0 || text.length > ICON_MAX_BYTES || !/<svg[\s>]/iu.test(text)) return false;
  if (
    /<\s*(?:script|foreignObject|iframe|object|embed|image|audio|video|use|a)\b/iu.test(text) ||
    /<!(?:ENTITY|DOCTYPE)/iu.test(text) ||
    /javascript:|data:|@import|url\(\s*["']?\s*(?:https?:|\/\/)/iu.test(text) ||
    /\son[a-z]+\s*=/iu.test(text)
  ) {
    return false;
  }
  for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/giu)) {
    if (!match[1]!.startsWith("#")) return false;
  }
  return true;
}

export interface ProviderCatalogOptions {
  /** Folder for the cached registry (`config.stateDir` in the server). */
  readonly stateDirectory: string;
  readonly registryUrl?: string;
  /** Optional address of a newer overlay. Null/undefined: the bundled overlay only. */
  readonly overlayUrl?: string | null;
  readonly platform?: RegistryPlatform | null;
  readonly transport?: TransportOptions;
  readonly builtIns?: ReadonlyArray<BuiltInDescriptor>;
  /** Catalogue id to the instance already created from it (from the provider instance settings). */
  readonly added?: Effect.Effect<ReadonlyMap<string, string>>;
  /** False stops network fetches, as the provider update-check setting does. The cached copy stays in use. */
  readonly networkAllowed?: Effect.Effect<boolean>;
  readonly iconUrlFor?: (catalogId: string) => string;
}

interface ProviderCatalogService {
  readonly list: (input: ProviderCatalogListInput) => Effect.Effect<ProviderCatalogListResult>;
  /** The registry agent and overlay entry the installer needs, or null for an unknown id. */
  readonly installRequest: (catalogId: string) => Effect.Effect<CatalogInstallRequest | null>;
  readonly installPlan: (catalogId: string) => Effect.Effect<InstallPlan | null>;
  /** What the install sheet shows (SPEC 5.2): size, room needed, where from. Null for an id that cannot be installed. */
  readonly installFacts: (catalogId: string) => Effect.Effect<ProviderCatalogInstallPlan | null>;
  readonly overlayEntry: (catalogId: string) => Effect.Effect<CatalogOverlayEntry | undefined>;
  /** The icon as served: reviewed SVG text, or null. */
  readonly icon: (catalogId: string) => Effect.Effect<string | null>;
  readonly refresh: (force?: boolean) => Effect.Effect<void>;
}

export class ProviderCatalog extends Context.Service<ProviderCatalog, ProviderCatalogService>()(
  "t3/provider/catalog/ProviderCatalog",
) {}

export const makeProviderCatalog = Effect.fn("ProviderCatalog.make")(function* (
  options: ProviderCatalogOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArch = yield* HostProcessArchitecture;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform =
    options.platform === undefined ? registryPlatformKey(hostPlatform, hostArch) : options.platform;
  const transport = options.transport ?? {};
  const registryUrl = options.registryUrl ?? REGISTRY_URL;
  const builtIns = options.builtIns ?? BUILT_IN_DESCRIPTORS;
  const iconUrlFor = options.iconUrlFor ?? defaultIconUrlFor;
  const cachePath = path.join(options.stateDirectory, CACHE_FILE);
  const iconDirectory = path.join(options.stateDirectory, "provider-catalog-icons");
  const gate = yield* Semaphore.make(1);

  let registry: ParsedRegistry | null = null;
  let fetchedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  let lastAttemptFailed = false;
  let cachedOverlay: CatalogOverlay | null = null;
  const sizes = new Map<string, number>();
  const icons = new Map<string, string | null>();
  let sizeProbeRunning = false;
  let lastProbeAtMs: number | null = null;

  const loadFromDisk = yield* Effect.cached(
    Effect.gen(function* () {
      const cache = yield* fs.readFileString(cachePath).pipe(
        Effect.flatMap((text) => decodeCache(text)),
        Effect.option,
      );
      if (Option.isNone(cache)) return;
      const parsed = parseRegistry(cache.value.registry);
      if (parsed === null) return;
      registry = parsed;
      fetchedAtMs = cache.value.fetchedAtMs;
      for (const [url, bytes] of Object.entries(cache.value.sizes)) sizes.set(url, bytes);
      if (cache.value.overlay !== undefined) cachedOverlay = parseOverlay(cache.value.overlay);
    }),
  );

  /** Keeps the file in step with memory; a failed write only loses the cache. */
  const persist = (rawRegistry: unknown) =>
    Effect.gen(function* () {
      if (fetchedAtMs === null) return;
      const body: CacheFile = {
        schema: 1,
        fetchedAtMs,
        registry: rawRegistry,
        sizes: Object.fromEntries(sizes),
        ...(cachedOverlay === null ? {} : { overlay: cachedOverlay }),
      };
      const text = yield* encodeCache(body);
      yield* fs.makeDirectory(options.stateDirectory, { recursive: true });
      const temporary = `${cachePath}.tmp`;
      yield* fs.writeFileString(temporary, text, { mode: 0o600 });
      yield* fs.rename(temporary, cachePath);
    }).pipe(Effect.ignore);

  let rawRegistryForPersist: unknown = null;

  const overlay = (): CatalogOverlay => newerOverlay(BUNDLED_CATALOG_OVERLAY, cachedOverlay);

  const allowed = options.networkAllowed ?? Effect.succeed(true);

  const probeSizes = Effect.fn("ProviderCatalog.probeSizes")(function* () {
    if (sizeProbeRunning || registry === null) return;
    const now = yield* Clock.currentTimeMillis;
    // Heads that failed are tried again in an hour, not on every list.
    if (lastProbeAtMs !== null && now >= lastProbeAtMs && now - lastProbeAtMs < PROBE_RETRY_MS)
      return;
    lastProbeAtMs = now;
    sizeProbeRunning = true;
    const current = registry;
    const urls = new Set<string>();
    const merged = overlay();
    for (const agent of current.agents) {
      const target = platform === null ? undefined : agent.binary[platform];
      if (target === undefined) continue;
      const plan = resolveInstallPlan(agent, { platform, overlay: merged.entries[agent.id] });
      if (plan.kind === "binary" || plan.kind === "unsupported") urls.add(target.archive);
    }
    const missing = [...urls].filter((url) => !sizes.has(url));
    yield* Effect.forEach(
      missing,
      (url) =>
        headSize(http, url, transport).pipe(
          Effect.timeout(SIZE_PROBE_TIMEOUT),
          Effect.tap((bytes) =>
            Effect.sync(() => (bytes === null ? undefined : sizes.set(url, bytes))),
          ),
          Effect.ignore,
        ),
      { concurrency: SIZE_PROBE_CONCURRENCY, discard: true },
    ).pipe(Effect.ensuring(Effect.sync(() => (sizeProbeRunning = false))));
    if (missing.length > 0) yield* persist(rawRegistryForPersist);
  });

  const fetchRegistry = Effect.fn("ProviderCatalog.fetchRegistry")(function* () {
    const text = yield* fetchText(http, registryUrl, REGISTRY_MAX_BYTES, transport).pipe(
      Effect.timeout(FETCH_TIMEOUT),
      Effect.option,
    );
    if (Option.isNone(text)) return false;
    const parsed = parseRegistryText(text.value);
    if (parsed === null) return false;
    const now = yield* Clock.currentTimeMillis;
    registry = parsed;
    fetchedAtMs = now;
    // The raw JSON is what the cache keeps, so a parser fix applies to old copies.
    rawRegistryForPersist = yield* decodeJsonDocument(text.value).pipe(
      Effect.orElseSucceed(() => null),
    );
    return true;
  });

  const fetchOverlay = Effect.fn("ProviderCatalog.fetchOverlay")(function* () {
    if (options.overlayUrl === undefined || options.overlayUrl === null) return;
    const text = yield* fetchText(http, options.overlayUrl, OVERLAY_MAX_BYTES, transport).pipe(
      Effect.timeout(FETCH_TIMEOUT),
      Effect.option,
    );
    if (Option.isNone(text)) return;
    const parsed = parseOverlayText(text.value);
    if (parsed !== null) cachedOverlay = parsed;
  });

  const refresh = Effect.fn("ProviderCatalog.refresh")(function* (force = false) {
    yield* loadFromDisk;
    yield* gate.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const fresh =
          fetchedAtMs !== null && now >= fetchedAtMs && now - fetchedAtMs < REGISTRY_TTL_MS;
        const waiting =
          lastAttemptMs !== null &&
          now >= lastAttemptMs &&
          now - lastAttemptMs < RETRY_AFTER_FAILURE_MS;
        if (!force && (fresh || (lastAttemptFailed && waiting))) return;
        if (!(yield* allowed)) return;
        lastAttemptMs = now;
        const ok = yield* fetchRegistry();
        lastAttemptFailed = !ok;
        yield* fetchOverlay();
        if (ok) yield* persist(rawRegistryForPersist);
      }),
    );
    // Sizes are best effort and never hold up the list.
    yield* probeSizes().pipe(Effect.ignore, Effect.forkIn(serviceScope), Effect.asVoid);
  });

  const addedMap = options.added ?? Effect.succeed(new Map<string, string>());

  const list: ProviderCatalogService["list"] = (input) =>
    Effect.gen(function* () {
      yield* loadFromDisk;
      const now = yield* Clock.currentTimeMillis;
      if (input.refresh === true || registry === null) {
        yield* refresh(input.refresh === true);
      } else if (fetchedAtMs === null || now - fetchedAtMs >= REGISTRY_TTL_MS) {
        yield* refresh(false).pipe(Effect.forkIn(serviceScope), Effect.asVoid);
      } else {
        yield* probeSizes().pipe(Effect.ignore, Effect.forkIn(serviceScope), Effect.asVoid);
      }
      const nodeAvailable = (yield* resolveNodePath(hostEnvironment)) !== null;
      const entries = buildCatalogEntries({
        registry,
        overlay: overlay(),
        platform,
        nodeAvailable,
        sizes,
        added: yield* addedMap,
        builtIns,
        iconUrlFor,
      });
      const at = fetchedAtMs;
      const stale = at === null || now - at >= REGISTRY_TTL_MS || lastAttemptFailed;
      return {
        entries,
        registryFetchedAt: at === null ? null : DateTime.formatIso(DateTime.makeUnsafe(at)),
        registryStale: stale,
      } satisfies ProviderCatalogListResult;
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const agentFor = (catalogId: string): RegistryAgent | null =>
    registry?.agents.find((agent) => agent.id === catalogId) ?? null;

  const installRequest: ProviderCatalogService["installRequest"] = (catalogId) =>
    loadFromDisk.pipe(
      Effect.map(() => {
        const agent = agentFor(catalogId);
        return agent === null ? null : { agent, overlay: overlay().entries[agent.id] };
      }),
    );

  const installPlan: ProviderCatalogService["installPlan"] = (catalogId) =>
    installRequest(catalogId).pipe(
      Effect.map((request) =>
        request === null
          ? null
          : resolveInstallPlan(request.agent, { platform, overlay: request.overlay }),
      ),
    );

  const installFacts: ProviderCatalogService["installFacts"] = (catalogId) =>
    installRequest(catalogId).pipe(
      Effect.map((request) => {
        if (request === null) return null;
        const plan = resolveInstallPlan(request.agent, { platform, overlay: request.overlay });
        if (plan.kind === "unsupported") return null;
        const downloadBytes = plan.kind === "binary" ? (sizes.get(plan.url) ?? null) : null;
        return {
          catalogId,
          version: request.agent.version,
          distribution:
            plan.kind === "binary"
              ? { kind: "binary", label: downloadLabel(plan.url, plan.host) }
              : { kind: "npm", label: `npm · ${plan.name}` },
          downloadBytes,
          requiredBytes: requiredFreeBytes(plan, downloadBytes),
          sha256Checked: plan.kind === "binary",
          host: plan.kind === "binary" ? plan.host : "registry.npmjs.org",
          runsInstallScripts: plan.kind === "npm",
        } satisfies ProviderCatalogInstallPlan;
      }),
    );

  const icon: ProviderCatalogService["icon"] = (catalogId) =>
    Effect.gen(function* () {
      yield* loadFromDisk;
      const agent = registryAgentForCatalogId(catalogId, registry, builtIns);
      if (agent === null || agent.icon === null) return null;
      const known = icons.get(agent.id);
      if (known !== undefined) return known;
      const file = path.join(iconDirectory, `${agent.id}.svg`);
      const onDisk = yield* fs.readFileString(file).pipe(Effect.option);
      if (Option.isSome(onDisk) && isSafeSvg(onDisk.value)) {
        icons.set(agent.id, onDisk.value);
        return onDisk.value;
      }
      const fetched = yield* fetchText(http, agent.icon, ICON_MAX_BYTES, transport).pipe(
        Effect.timeout(FETCH_TIMEOUT),
        Effect.option,
      );
      if (Option.isNone(fetched) || !isSafeSvg(fetched.value)) {
        // A rejected icon is remembered for the process so it is not fetched on every render.
        if (Option.isSome(fetched)) {
          yield* Effect.logWarning("Provider catalog icon refused", {
            catalogId: agent.id,
            host: redactUrls(agent.icon).slice(0, 100),
          });
          icons.set(agent.id, null);
        }
        return null;
      }
      yield* fs
        .makeDirectory(iconDirectory, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(file, fetched.value, { mode: 0o600 })),
          Effect.ignore,
        );
      icons.set(agent.id, fetched.value);
      return fetched.value;
    });

  return ProviderCatalog.of({
    list,
    installRequest,
    installPlan,
    installFacts,
    overlayEntry: (catalogId) => Effect.sync(() => overlay().entries[catalogId]),
    icon,
    refresh: (force) => refresh(force === true),
  });
});
