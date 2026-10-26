/**
 * `GET /api/personal/update/status`: where a Bots release is, for the small
 * status line on the Bots page (web features/personal/UpdateStatusLine.tsx).
 *
 * Read-only and signed-in only, the same session check as the other personal
 * routes. The answer comes from the release runner's result file
 * (`<run>\restart-<version>-result.json`, see updateStatus.ts), so the
 * filesystem work happens here and nowhere else:
 *
 * - every read is async Effect FileSystem work on the request path - no sync
 *   fs, no blocking of the event loop (the 1.66.33 stall fixes);
 * - the newest answer is cached for a few seconds, so a phone and a desktop
 *   polling together cost one directory read between them, and a poll during
 *   a phase change waits at most that long for the new word.
 */
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { authenticatePersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import {
  compareVersions,
  personalRunDir,
  readRestartResult,
  restartResultVersion,
  RESTART_RESULT_MAX_AGE_MS,
  updateStatusView,
  type UpdateStatusView,
} from "./updateStatus.ts";

export const PERSONAL_UPDATE_STATUS_PATH = "/api/personal/update/status";

/** How long one filesystem answer is reused across requests. */
export const UPDATE_STATUS_CACHE_MS = 5_000;

/** A restart result file is a handful of KB; anything larger is not one. */
const MAX_RESULT_BYTES = 64n * 1024n;
/** Live result files per run folder are few; statting them concurrently is bounded. */
const STAT_CONCURRENCY = 8;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const answerJson = (view: UpdateStatusView | null) =>
  HttpServerResponse.json(
    view ?? { phase: null, version: null, previousVersion: null, updatedAt: null },
    {
      headers: HEADERS,
    },
  ).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
  );

/** The version this server itself is running, from its served client stamp. */
const readLiveVersion = (staticDir: string | undefined, path: Path.Path) => {
  if (staticDir === undefined) return Effect.succeed(null as string | null);
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(path.join(staticDir, "version.txt"));
    return /^version=(.+)$/m.exec(text)?.[1]?.trim() || null;
  }).pipe(Effect.orElseSucceed(() => null));
};

/**
 * The newest restart result file in the run folder, within
 * RESTART_RESULT_MAX_AGE_MS, as the page's view - or null for nothing. A
 * missing folder, an unreadable or oversized file and a foreign status all
 * end in null.
 */
const readUpdateStatus = Effect.fn("readUpdateStatus")(function* (input: {
  readonly runDir: string;
  readonly staticDir: string | undefined;
  readonly nowMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(input.runDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const candidates = entries.filter((name) => restartResultVersion(name) !== null);
  if (candidates.length === 0) return null;

  const stamped = yield* Effect.forEach(
    candidates,
    (name) =>
      fileSystem.stat(path.join(input.runDir, name)).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? {
                name,
                // Candidates are named restart-<version>-result.json, so this
                // is never null here; "" only satisfies the type.
                version: restartResultVersion(name) ?? "",
                mtimeMs: Option.getOrNull(info.mtime)?.getTime() ?? null,
                size: ByteSize.toBigInt(info.size),
              }
            : null,
        ),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: STAT_CONCURRENCY },
  );

  let newest: { name: string; version: string; mtimeMs: number; size: bigint } | null = null;
  for (const entry of stamped) {
    if (entry === null || entry.mtimeMs === null) continue;
    if (input.nowMs - entry.mtimeMs > RESTART_RESULT_MAX_AGE_MS) continue;
    if (
      newest === null ||
      entry.mtimeMs > newest.mtimeMs ||
      // mtime is a Date, so two files written inside one millisecond report
      // the same time; the higher version is the newer run. Without this the
      // newest file would depend on the directory's listing order.
      (entry.mtimeMs === newest.mtimeMs && compareVersions(entry.version, newest.version) > 0)
    ) {
      newest = {
        name: entry.name,
        version: entry.version,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      };
    }
  }
  if (newest === null || newest.size > MAX_RESULT_BYTES) return null;

  const text = yield* fileSystem
    .readFileString(path.join(input.runDir, newest.name))
    .pipe(Effect.orElseSucceed(() => null));
  if (text === null) return null;
  const result = readRestartResult(text);
  if (result === null) return null;

  const liveVersion = yield* readLiveVersion(input.staticDir, path);
  return updateStatusView({
    status: result.status,
    version: result.version ?? restartResultVersion(newest.name),
    liveVersion,
    updatedAtMs: newest.mtimeMs,
    nowMs: input.nowMs,
  });
});

/**
 * The route factory, parameterised on the cache window so tests can turn the
 * cache off or let it lapse without clock tricks.
 */
export const makePersonalUpdateStatusRouteLayer = (options: { readonly cacheMs?: number } = {}) => {
  const cacheMs = options.cacheMs ?? UPDATE_STATUS_CACHE_MS;
  // One cache for the process: the answer is the same for every signed-in
  // caller, and the release runner's own writes are seconds to minutes apart.
  let cachedAt: number | null = null;
  let cached: UpdateStatusView | null = null;

  return HttpRouter.add(
    "GET",
    PERSONAL_UPDATE_STATUS_PATH,
    Effect.gen(function* () {
      // Authenticate before anything else so an anonymous probe learns nothing.
      yield* authenticatePersonalRoute(AuthOrchestrationReadScope);
      const nowMs = yield* Clock.currentTimeMillis;
      if (cachedAt !== null && nowMs - cachedAt < cacheMs) {
        return yield* answerJson(cached);
      }
      const config = yield* Effect.serviceOption(ServerConfig);
      const baseDir = config._tag === "Some" ? config.value.baseDir : undefined;
      const staticDir = config._tag === "Some" ? config.value.staticDir : undefined;
      const path = yield* Path.Path;
      const view =
        baseDir === undefined
          ? null
          : yield* readUpdateStatus({
              runDir: personalRunDir(baseDir, path),
              staticDir,
              nowMs,
            }).pipe(Effect.orElseSucceed(() => null as UpdateStatusView | null));
      cachedAt = nowMs;
      cached = view;
      return yield* answerJson(view);
    }).pipe(Effect.catchTags(personalRouteAuthResponses)),
  );
};

export const personalUpdateStatusRouteLayer = makePersonalUpdateStatusRouteLayer();
