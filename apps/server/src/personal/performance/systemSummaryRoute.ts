// @effect-diagnostics nodeBuiltinImport:off - Effect FileSystem has no statfs, the one call that reads free space.
/**
 * `GET /api/personal/performance/summary`: the PC's CPU, RAM and disk in one
 * small answer, for the line under the Bots page header (web
 * features/personal/SystemStatsLine.tsx).
 *
 * Signed-in only, the same session check as the other personal routes. It
 * never starts the Performance tab's sampler: CPU and RAM come from
 * HostResources (two `os.cpus()` readings 200 ms apart, cached 5 s for every
 * caller), and the disk from one `statfs` of the drive the server's data lives
 * on, cached a minute. A phone and a desktop polling together cost one reading.
 */
import * as NodeFs from "node:fs/promises";

import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";
import { authenticatePersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";

export const PERSONAL_SYSTEM_SUMMARY_PATH = "/api/personal/performance/summary";

/** Free space moves slowly; one statfs a minute is plenty. */
export const DISK_CACHE_MS = 60_000;

const GB = 1024 ** 3;

export interface SystemSummary {
  /** Whole machine, 0-100, or null before a reading. */
  readonly cpuPct: number | null;
  readonly memUsedPct: number | null;
  readonly memUsedGB: number | null;
  readonly memTotalGB: number | null;
  /** The drive holding the server's data, e.g. "C:". */
  readonly diskLabel: string | null;
  readonly diskFreeGB: number | null;
  readonly diskTotalGB: number | null;
}

interface DiskReading {
  readonly label: string;
  readonly freeGB: number;
  readonly totalGB: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** "C:\\" -> "C:", "/" -> "/". */
export function diskLabelOf(root: string): string {
  const drive = /^([A-Za-z]:)[\\/]?$/.exec(root)?.[1];
  return drive ? drive.toUpperCase() : root;
}

export function systemSummaryFrom(input: {
  readonly cpuUtilization: number | null;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly disk: DiskReading | null;
}): SystemSummary {
  const total = input.totalMemoryBytes;
  const used = Math.max(0, total - input.availableMemoryBytes);
  return {
    cpuPct: input.cpuUtilization === null ? null : Math.round(input.cpuUtilization * 100),
    memUsedPct: total > 0 ? Math.round((used / total) * 100) : null,
    memUsedGB: total > 0 ? round1(used / GB) : null,
    memTotalGB: total > 0 ? round1(total / GB) : null,
    diskLabel: input.disk?.label ?? null,
    diskFreeGB: input.disk?.freeGB ?? null,
    diskTotalGB: input.disk?.totalGB ?? null,
  };
}

const readDisk = (root: string) =>
  Effect.tryPromise(() => NodeFs.statfs(root)).pipe(
    Effect.map((stats): DiskReading => ({
      label: diskLabelOf(root),
      freeGB: round1((stats.bavail * stats.bsize) / GB),
      totalGB: round1((stats.blocks * stats.bsize) / GB),
    })),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => null),
  );

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export const makePersonalSystemSummaryRouteLayer = (
  options: { readonly diskCacheMs?: number } = {},
) => {
  const diskCacheMs = options.diskCacheMs ?? DISK_CACHE_MS;
  let diskAt: number | null = null;
  let disk: DiskReading | null = null;

  return HttpRouter.add(
    "GET",
    PERSONAL_SYSTEM_SUMMARY_PATH,
    Effect.gen(function* () {
      // Authenticate before anything else so an anonymous probe learns nothing.
      yield* authenticatePersonalRoute(AuthOrchestrationReadScope);
      const nowMs = yield* Clock.currentTimeMillis;
      if (diskAt === null || nowMs - diskAt >= diskCacheMs) {
        const config = yield* Effect.serviceOption(ServerConfig);
        const path = yield* Path.Path;
        const baseDir = config._tag === "Some" ? config.value.baseDir : ".";
        disk = yield* readDisk(path.parse(path.resolve(baseDir)).root);
        diskAt = nowMs;
      }
      const host = yield* (yield* HostResources).read;
      return yield* HttpServerResponse.json(
        systemSummaryFrom({
          cpuUtilization: host.cpuUtilization,
          availableMemoryBytes: host.availableMemoryBytes,
          totalMemoryBytes: host.totalMemoryBytes,
          disk,
        }),
        { headers: HEADERS },
      ).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Internal Server Error", { status: 500 }),
        ),
      );
    }).pipe(Effect.catchTags(personalRouteAuthResponses)),
  );
};

export const personalSystemSummaryRouteLayer = makePersonalSystemSummaryRouteLayer();
