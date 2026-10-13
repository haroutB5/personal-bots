// @effect-diagnostics globalConsole:off
/**
 * `GET /api/personal/performance/stream`: the Performance tab's live feed.
 *
 * Server-sent events behind the same signed-in check as the other personal
 * routes, never unauthenticated. One connection is one viewer: the sampler
 * starts on the first subscriber and stops about ten seconds after the last
 * one disconnects, and `hello` carries the ring buffer so a reload keeps its
 * charts. Nothing here samples anything by itself.
 */
import { AuthOrchestrationReadScope, type PerformanceStatics } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { authenticatePersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import {
  PersonalBotRepository,
  type PersonalBotProviderSession,
} from "../PersonalBotRepository.ts";
import type { BotOwner } from "./processGroups.ts";
import type { PerformanceSampler } from "./performanceSampler.ts";
import {
  buildPerformanceSampler,
  childSessionIds,
  processStartedAt,
  type BuildSamplerDeps,
} from "./runtime.ts";
import type { PerformanceStreamEvent } from "@t3tools/contracts";

export const PERSONAL_PERFORMANCE_STREAM_PATH = "/api/personal/performance/stream";

/** The version this server runs, from the served client stamp. */
const readVersion = (staticDir: string | undefined) =>
  Effect.gen(function* () {
    if (staticDir === undefined) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem.readFileString(path.join(staticDir, "version.txt"));
    return /^version=(.+)$/m.exec(text)?.[1]?.trim() || null;
  }).pipe(Effect.orElseSucceed(() => null));

export interface PerformanceRouteOptions {
  /** Test seam: build the sampler with fake machine deps. */
  readonly buildSampler?: (deps: BuildSamplerDeps) => PerformanceSampler;
}

/**
 * The route factory. The sampler is a per-process singleton, built on the
 * first request: it outlives every connection, which is what keeps the
 * history across reloads.
 */
export const makePersonalPerformanceStreamRouteLayer = (options: PerformanceRouteOptions = {}) => {
  const build = options.buildSampler ?? buildPerformanceSampler;
  let sampler: PerformanceSampler | null = null;

  return HttpRouter.add(
    "GET",
    PERSONAL_PERFORMANCE_STREAM_PATH,
    Effect.gen(function* () {
      // Authenticate before anything else so an anonymous probe learns nothing.
      yield* authenticatePersonalRoute(AuthOrchestrationReadScope);
      const config = yield* Effect.serviceOption(ServerConfig);
      const baseDir = config._tag === "Some" ? config.value.baseDir : undefined;
      const staticDir = config._tag === "Some" ? config.value.staticDir : undefined;
      const repository = yield* PersonalBotRepository;
      const context = yield* Effect.context<PersonalBotRepository>();

      if (sampler === null) {
        const version = yield* readVersion(staticDir);
        const startedAtMs = processStartedAt();
        const statics = (): PerformanceStatics => ({
          pcModel: null,
          pcCpu: null,
          pcCores: null,
          pcThreads: null,
          pcGpu: null,
          ramGB: null,
          pcBootAt: null,
          hbotsVersion: version,
          hbotsStartedAt: startedAtMs,
        });
        // pid -> bot, from the CLI command lines and the session projection.
        const attribute = (
          children: Parameters<NonNullable<BuildSamplerDeps["attribute"]>>[0],
        ): Promise<ReadonlyMap<number, BotOwner>> => {
          const pairs = childSessionIds(children);
          if (pairs.length === 0) return Promise.resolve(new Map());
          const query = repository
            .listBotProviderSessions()
            .pipe(Effect.orElseSucceed((): ReadonlyArray<PersonalBotProviderSession> => []));
          return Effect.runPromiseWith(context)(query).then((rows) => {
            const bySession = new Map(
              rows.map((row) => [row.providerSessionId.toLowerCase(), row] as const),
            );
            const owners = new Map<number, BotOwner>();
            for (const pair of pairs) {
              const row = bySession.get(pair.sessionId);
              if (row !== undefined) owners.set(pair.pid, { botId: row.botId, name: row.botName });
            }
            return owners;
          });
        };
        sampler = build({
          baseDir: baseDir ?? ".",
          log: (line) => {
            console.log(`[performance] ${line}`);
          },
          startedAtMs,
          attribute,
          readStatics: statics,
        });
      }
      const active = sampler;
      if (active === null) {
        return HttpServerResponse.text("Unavailable", { status: 503 });
      }

      const queue = yield* Queue.unbounded<PerformanceStreamEvent>();
      const subscription = active.subscribe((event) => {
        Queue.offerUnsafe(queue, event);
      });
      Queue.offerUnsafe(queue, subscription.hello);

      const encoder = new TextEncoder();
      const body = Stream.fromQueue(queue).pipe(
        Stream.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
        // Either side ending (a client disconnect, the server shutting down)
        // gives the viewer slot back, exactly once.
        Stream.ensuring(Effect.sync(() => subscription.unsubscribe())),
      );
      return HttpServerResponse.stream(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    }).pipe(Effect.catchTags(personalRouteAuthResponses)),
  );
};

export const personalPerformanceStreamRouteLayer = makePersonalPerformanceStreamRouteLayer();
