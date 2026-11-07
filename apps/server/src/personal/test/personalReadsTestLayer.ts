/**
 * The personal read ports over an in-memory v2 database.
 *
 * Personal SQL still names the five projection relations by their v1 names.
 * This layer creates read-only views with those names over the v2 projection
 * tables, so the unchanged queries run on v2 data. Tests seed the v2 tables.
 *
 * The production relations implementation is C16; this file is the test
 * harness until then.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectService } from "../../project/ProjectService.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import {
  ProjectionStoreV2,
  layer as ProjectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { PersonalEngineV2Live } from "../engine/PersonalEngineV2Live.ts";
import { PersonalProjectionRelations } from "../engine/PersonalProjectionRelations.ts";
import { PERSONAL_V2_RELATIONS } from "../engine/PersonalProjectionRelationsV2Live.ts";
import { layer as memoryLayer } from "../memory/PersonalMemoryService.ts";

/** In-memory v2 database. The v1 projection tables still exist because B1 holds 063. */
export const personalTestDatabase = SqlitePersistence.layerMemory;

const readThreadsLayer = Layer.effect(
  ThreadManagementService.ThreadManagementService,
  Effect.gen(function* () {
    const projection = yield* ProjectionStoreV2;
    return {
      getThreadShell: projection.getThreadShell,
      getThreadRecords: projection.getThreadRecords,
      getShellSnapshot: projection.getShellSnapshot,
      dispatch: () => Effect.die("unused in personal read tests"),
      interruptThread: () => Effect.die("unused in personal read tests"),
      streamDomainEvents: Stream.empty,
    } as never;
  }),
).pipe(Layer.provide(ProjectionStoreLayer));

const projectsLayer = Layer.succeed(ProjectService, {
  create: () => Effect.die("unused in personal read tests"),
  getShell: () => Effect.succeed(Option.none()),
  listShells: () => Effect.succeed([]),
} as never);

const eventSinkLayer = Layer.succeed(EventSinkV2, {
  write: () => Effect.succeed([]),
} as never);

/** PersonalEngine and PersonalProjectionRelations over the test database. */
export const personalReadsTestLayer = PersonalEngineV2Live.pipe(
  Layer.provide(readThreadsLayer),
  Layer.provide(projectsLayer),
  Layer.provide(eventSinkLayer),
  Layer.provideMerge(Layer.succeed(PersonalProjectionRelations, PERSONAL_V2_RELATIONS)),
);

/** PersonalMemoryService over the read ports above. Needs the test database. */
export const personalMemoryTestLayer = memoryLayer.pipe(Layer.provideMerge(personalReadsTestLayer));
