import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { parseClaudeModelSlug } from "../ClaudeModelCatalog.ts";

const DISCOVERY_CACHE_VERSION = 1;
const MODEL_MATCH_OVERLAP = 128;
const MODEL_CANDIDATE =
  /(?<![A-Za-z0-9-])claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*(?![A-Za-z0-9-])/g;

const DiscoveryCacheEntry = Schema.Struct({
  executablePath: Schema.String,
  cliVersion: Schema.String,
  size: Schema.String,
  mtimeMs: Schema.NullOr(Schema.Number),
  slugs: Schema.Array(Schema.String),
});

const DiscoveryCacheFile = Schema.Struct({
  version: Schema.Literal(DISCOVERY_CACHE_VERSION),
  entries: Schema.Array(DiscoveryCacheEntry),
});

type DiscoveryCacheEntry = typeof DiscoveryCacheEntry.Type;
const DiscoveryCacheCodec = Schema.fromJsonString(
  DiscoveryCacheFile as unknown as Schema.Codec<typeof DiscoveryCacheFile.Type>,
);
const decodeDiscoveryCache = Schema.decodeUnknownEffect(DiscoveryCacheCodec);
const encodeDiscoveryCache = Schema.encodeEffect(DiscoveryCacheCodec);

export interface ClaudeModelBinaryFingerprint {
  readonly executablePath: string;
  readonly cliVersion: string;
  readonly size: string;
  readonly mtimeMs: number | null;
}

function scanModelCandidates(
  text: string,
  includeTrailingMatch: boolean,
  output: Set<string>,
): void {
  MODEL_CANDIDATE.lastIndex = 0;
  for (const match of text.matchAll(MODEL_CANDIDATE)) {
    const slug = match[0];
    if (!includeTrailingMatch && match.index + slug.length === text.length) continue;
    if (parseClaudeModelSlug(slug)) output.add(slug);
  }
}

/** Pure chunk scanner used by the streamed binary reader and boundary tests. */
export function scanClaudeModelSlugChunks(
  chunks: Iterable<Uint8Array | string>,
): ReadonlySet<string> {
  const slugs = new Set<string>();
  let tail = "";
  for (const chunk of chunks) {
    const text = tail + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1"));
    scanModelCandidates(text, false, slugs);
    tail = text.slice(-(MODEL_MATCH_OVERLAP + 1));
  }
  scanModelCandidates(tail, true, slugs);
  return slugs;
}

function cacheEntryMatches(
  entry: DiscoveryCacheEntry,
  fingerprint: ClaudeModelBinaryFingerprint,
): boolean {
  return (
    entry.executablePath === fingerprint.executablePath &&
    entry.cliVersion === fingerprint.cliVersion &&
    entry.size === fingerprint.size &&
    entry.mtimeMs === fingerprint.mtimeMs
  );
}

const readCache = Effect.fn("readClaudeModelDiscoveryCache")(function* (cachePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(cachePath).pipe(Effect.orElseSucceed(() => false)))) return [];
  return yield* fileSystem.readFileString(cachePath).pipe(
    Effect.flatMap(decodeDiscoveryCache),
    Effect.map((cache) => [...cache.entries]),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read Claude model discovery cache; ignoring it.", {
        path: cachePath,
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as([])),
    ),
  );
});

const scanBinary = Effect.fn("scanClaudeBinaryForModels")(function* (executablePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const slugs = new Set<string>();
  let tail = "";
  yield* fileSystem.stream(executablePath).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        const text = tail + Buffer.from(chunk).toString("latin1");
        scanModelCandidates(text, false, slugs);
        tail = text.slice(-(MODEL_MATCH_OVERLAP + 1));
      }),
    ),
  );
  scanModelCandidates(tail, true, slugs);
  return [...slugs].toSorted();
});

export const discoverClaudeModelSlugs = Effect.fn("discoverClaudeModelSlugs")(function* (input: {
  readonly executablePath: string;
  readonly cliVersion: string;
  readonly cachePath: string;
}): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(input.executablePath).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not inspect the Claude executable for model discovery.", {
        executablePath: input.executablePath,
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(undefined)),
    ),
  );
  if (!info || info.type !== "File") return [];

  const fingerprint: ClaudeModelBinaryFingerprint = {
    executablePath: input.executablePath,
    cliVersion: input.cliVersion,
    size: info.size.toString(),
    mtimeMs: Option.match(info.mtime, {
      onNone: () => null,
      onSome: (mtime) => mtime.getTime(),
    }),
  };
  const entries = yield* readCache(input.cachePath);
  const cached = entries.find((entry) => cacheEntryMatches(entry, fingerprint));
  if (cached) return cached.slugs;

  const slugs = yield* scanBinary(input.executablePath).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not scan the Claude executable for supported models.", {
        executablePath: input.executablePath,
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as([])),
    ),
  );
  if (slugs.length === 0) {
    yield* Effect.logDebug("Claude executable model discovery found no bare model slugs.", {
      executablePath: input.executablePath,
    });
  }

  const nextEntries = [
    ...entries.filter((entry) => !cacheEntryMatches(entry, fingerprint)),
    { ...fingerprint, slugs },
  ];
  yield* encodeDiscoveryCache({ version: DISCOVERY_CACHE_VERSION, entries: nextEntries }).pipe(
    Effect.flatMap((contents) =>
      writeFileStringAtomically({ filePath: input.cachePath, contents: `${contents}\n` }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not persist the Claude model discovery cache.", {
        path: input.cachePath,
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
  return slugs;
});
