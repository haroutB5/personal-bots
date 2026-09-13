import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  CommandId,
  isProviderAvailable,
  PersonalBotId,
  PersonalBotsError,
  PersonalBotThread,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type PersonalBot,
  type PersonalBotCreateInput,
  type PersonalBotsListResult,
  type PersonalBotUpdateInput,
  type ServerProvider,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";

const PERSONAL_META_SEEDED = "seeded";
const PERSONAL_META_PROJECT_ID = "personalProjectId";
const PERSONAL_WORKSPACE_DIRNAME = "personal-workspace";
const PERSONAL_PROJECT_TITLE = "Personal";
const PERSONAL_THREAD_TITLE = "New chat";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface SeedBotDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly avatarShape: PersonalBot["avatarShape"];
  readonly avatarColor: string;
  readonly driver: typeof CLAUDE_DRIVER | typeof CODEX_DRIVER;
}

const SEED_BOT_DEFINITIONS: ReadonlyArray<SeedBotDefinition> = [
  {
    key: "assistant",
    name: "Assistant",
    description: "Understands requests, organizes work, delegates and reviews results.",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    driver: CLAUDE_DRIVER,
  },
  {
    key: "developer",
    name: "Developer",
    description: "Implements, tests and returns reviewable changes.",
    avatarShape: "roundedHexagon",
    avatarColor: "#F26A1B",
    driver: CODEX_DRIVER,
  },
  {
    key: "researcher",
    name: "Researcher",
    description: "Researches, compares options and returns sources.",
    avatarShape: "scallopedCloud",
    avatarColor: "#F0457E",
    driver: CODEX_DRIVER,
  },
  {
    key: "planner",
    name: "Planner",
    description: "Prepares plans and manages routines.",
    avatarShape: "roundedSquare",
    avatarColor: "#E5323B",
    driver: CLAUDE_DRIVER,
  },
];

const seedBotId = (key: string): PersonalBotId =>
  // Deterministic ids keep a retried seed from duplicating bots: the flag is
  // the primary guard, the id is the backstop.
  PersonalBotId.make(`personal-seed-${key}`);

const toPersonalBotsError = (message: string) => (cause: unknown) =>
  new PersonalBotsError({ message, cause });

export class PersonalBotService extends Context.Service<
  PersonalBotService,
  {
    readonly list: () => Effect.Effect<PersonalBotsListResult, PersonalBotsError>;
    readonly create: (
      input: PersonalBotCreateInput,
    ) => Effect.Effect<PersonalBot, PersonalBotsError>;
    readonly update: (
      input: PersonalBotUpdateInput,
    ) => Effect.Effect<PersonalBot, PersonalBotsError>;
    readonly remove: (input: {
      readonly botId: PersonalBotId;
    }) => Effect.Effect<void, PersonalBotsError>;
    readonly createThread: (input: {
      readonly botId: PersonalBotId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<PersonalBotThread, PersonalBotsError>;
    readonly archiveThread: (input: {
      readonly threadId: ThreadId;
      readonly archived: boolean;
    }) => Effect.Effect<PersonalBotThread, PersonalBotsError>;
    readonly seedDefaultsIfNeeded: Effect.Effect<ReadonlyArray<PersonalBot>, PersonalBotsError>;
  }
>()("t3/personal/PersonalBotService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const randomUuid = () => Effect.sync(() => NodeCrypto.randomUUID());

  const repositoryError = (operation: string) => (cause: unknown) =>
    new PersonalBotsError({ message: `Personal bots ${operation} failed.`, cause });

  const notFound = (message: string) => new PersonalBotsError({ message });

  // Live bots only: soft-deleted bots keep their threads but take no new ones.
  const requireBot = Effect.fn("PersonalBotService.requireBot")(function* (botId: PersonalBotId) {
    const bots = yield* repository.listBots().pipe(Effect.mapError(repositoryError("lookup")));
    const existing = bots.find((bot) => bot.botId === botId);
    if (existing === undefined) {
      return yield* notFound(`Personal bot '${botId}' was not found.`);
    }
    return existing;
  });

  // The default model comes from the live provider snapshot, whose `isDefault`
  // flags are derived from the ModelManifest catalog defaults — never from a
  // hard-coded model id in this file.
  const defaultModelForInstance = (instance: ServerProvider): string | undefined =>
    instance.models.find((model) => model.isDefault === true)?.slug ??
    instance.models.find((model) => model.isLegacy !== true)?.slug ??
    instance.models[0]?.slug;

  const seedDefaultsIfNeeded: PersonalBotService["Service"]["seedDefaultsIfNeeded"] = Effect.gen(
    function* () {
      const seeded = yield* repository
        .getMeta({ key: PERSONAL_META_SEEDED })
        .pipe(Effect.mapError(repositoryError("seed lookup")));
      if (Option.isSome(seeded) && seeded.value === "1") {
        return [] as ReadonlyArray<PersonalBot>;
      }
      const available = (yield* providers.getProviders).filter(
        (snapshot) => isProviderAvailable(snapshot) && snapshot.enabled && snapshot.installed,
      );
      if (available.length === 0) {
        // No provider to seed from yet. The flag stays unset so the next
        // call — after a provider appears — seeds exactly once.
        return [] as ReadonlyArray<PersonalBot>;
      }
      const fallback = available[0]!;
      const instanceFor = (driver: ProviderDriverKind): ServerProvider =>
        available.find((snapshot) => snapshot.driver === driver) ?? fallback;
      const now = yield* DateTime.now;
      const created: Array<PersonalBot> = [];
      for (const [index, definition] of SEED_BOT_DEFINITIONS.entries()) {
        const botId = seedBotId(definition.key);
        const already = yield* repository
          .getBotById({ botId })
          .pipe(Effect.mapError(repositoryError("seed lookup")));
        if (Option.isSome(already)) {
          continue;
        }
        const instance = instanceFor(definition.driver);
        const model = defaultModelForInstance(instance);
        if (model === undefined) {
          continue;
        }
        yield* repository
          .createBot({
            botId,
            name: definition.name,
            // The description doubles as the starting bot instruction.
            description: definition.description,
            instructions: definition.description,
            avatarShape: definition.avatarShape,
            avatarColor: definition.avatarColor,
            modelSelection: {
              instanceId: instance.instanceId,
              model,
            },
            sortOrder: index,
            createdAt: now,
            updatedAt: now,
          })
          .pipe(Effect.mapError(repositoryError("seed create")));
        const inserted = yield* repository
          .getBotById({ botId })
          .pipe(Effect.mapError(repositoryError("seed lookup")));
        if (Option.isSome(inserted)) {
          created.push(inserted.value);
        }
      }
      yield* repository
        .setMeta({ key: PERSONAL_META_SEEDED, value: "1" })
        .pipe(Effect.mapError(repositoryError("seed flag")));
      return created as ReadonlyArray<PersonalBot>;
    },
  );

  const personalWorkspaceRoot = () => path.join(config.baseDir, PERSONAL_WORKSPACE_DIRNAME);

  // The Personal workspace is an ordinary T3 project so bot threads reuse
  // streaming, approvals and providers unchanged. Its id is pinned in
  // personal_meta; a deleted project is recreated (with a fresh id) on next
  // use rather than resurrected.
  const ensurePersonalProject = Effect.fn("PersonalBotService.ensurePersonalProject")(function* () {
    const stored = yield* repository
      .getMeta({ key: PERSONAL_META_PROJECT_ID })
      .pipe(Effect.mapError(repositoryError("project lookup")));
    if (Option.isSome(stored)) {
      const projectId = ProjectId.make(stored.value);
      const project = yield* snapshots
        .getProjectShellById(projectId)
        .pipe(Effect.mapError(repositoryError("project lookup")));
      if (Option.isSome(project)) {
        return projectId;
      }
    }
    const workspaceRoot = personalWorkspaceRoot();
    // Crash recovery: the project may exist while its meta pointer was lost.
    const shells = yield* snapshots
      .getProjectShells()
      .pipe(Effect.mapError(repositoryError("project lookup")));
    const adopted = shells.find((shell) => shell.workspaceRoot === workspaceRoot);
    if (adopted !== undefined) {
      yield* repository
        .setMeta({ key: PERSONAL_META_PROJECT_ID, value: adopted.id })
        .pipe(Effect.mapError(repositoryError("project link")));
      return adopted.id;
    }
    yield* fs
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError(toPersonalBotsError("Personal bots workspace creation failed.")));
    const projectId = ProjectId.make(yield* randomUuid());
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "project.create",
        commandId: CommandId.make(`personal-bots:project.create:${projectId}`),
        projectId,
        title: PERSONAL_PROJECT_TITLE,
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        createdAt,
      })
      .pipe(Effect.mapError(toPersonalBotsError("Personal bots project creation failed.")));
    yield* repository
      .setMeta({ key: PERSONAL_META_PROJECT_ID, value: projectId })
      .pipe(Effect.mapError(repositoryError("project link")));
    return projectId;
  });

  const list: PersonalBotService["Service"]["list"] = () =>
    Effect.gen(function* () {
      // Lazy seeding covers servers that started before any provider was
      // configured. A seeding failure must never break listing bots.
      yield* seedDefaultsIfNeeded.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Personal bots default seeding failed; listing without seeding.", {
            cause,
          }),
        ),
      );
      const [bots, threads, storedProjectId] = yield* Effect.all([
        repository.listBots().pipe(Effect.mapError(repositoryError("list"))),
        repository.listThreadLinks().pipe(Effect.mapError(repositoryError("list"))),
        repository
          .getMeta({ key: PERSONAL_META_PROJECT_ID })
          .pipe(Effect.mapError(repositoryError("list"))),
      ]);
      return {
        bots: [...bots],
        threads: [...threads],
        personalProjectId: Option.isSome(storedProjectId)
          ? ProjectId.make(storedProjectId.value)
          : null,
      } satisfies PersonalBotsListResult;
    });

  const create: PersonalBotService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      // The botId is the client-generated idempotency key: creating twice
      // with the same id returns the existing bot instead of duplicating it.
      const existing = yield* repository
        .getBotById({ botId: input.botId })
        .pipe(Effect.mapError(repositoryError("lookup")));
      if (Option.isSome(existing)) {
        return existing.value;
      }
      const now = yield* DateTime.now;
      const siblings = yield* repository
        .listBots()
        .pipe(Effect.mapError(repositoryError("create")));
      const sortOrder = siblings.reduce((max, bot) => Math.max(max, bot.sortOrder), -1) + 1;
      yield* repository
        .createBot({ ...input, sortOrder, createdAt: now, updatedAt: now })
        .pipe(Effect.mapError(repositoryError("create")));
      const inserted = yield* repository
        .getBotById({ botId: input.botId })
        .pipe(Effect.mapError(repositoryError("create")));
      if (Option.isNone(inserted)) {
        return yield* notFound(`Personal bot '${input.botId}' could not be read after creation.`);
      }
      return inserted.value;
    });

  const update: PersonalBotService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const updated = yield* repository
        .updateBot({ ...input, updatedAt: now })
        .pipe(Effect.mapError(repositoryError("update")));
      if (Option.isNone(updated)) {
        return yield* notFound(`Personal bot '${input.botId}' was not found.`);
      }
      return updated.value;
    });

  const remove: PersonalBotService["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* repository
        .softDeleteBot({ botId: input.botId, deletedAt: now })
        .pipe(Effect.mapError(repositoryError("delete")));
      // Bot threads stay intact: only the bot row is tombstoned.
    });

  const createThread: PersonalBotService["Service"]["createThread"] = (input) =>
    Effect.gen(function* () {
      const bot = yield* requireBot(input.botId);
      const linked = yield* repository
        .getThreadLink({ threadId: input.threadId })
        .pipe(Effect.mapError(repositoryError("thread lookup")));
      if (Option.isSome(linked)) {
        return linked.value;
      }
      const projectId = yield* ensurePersonalProject();
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      yield* engine
        .dispatch({
          type: "thread.create",
          // Deterministic per thread: a retried createThread reuses the
          // command receipt instead of creating the thread twice.
          commandId: CommandId.make(`personal-bots:thread.create:${input.threadId}`),
          threadId: input.threadId,
          projectId,
          title: PERSONAL_THREAD_TITLE,
          modelSelection: bot.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
        .pipe(Effect.mapError(toPersonalBotsError("Personal bots thread creation failed.")));
      const stored = yield* repository
        .insertThreadLink({ botId: input.botId, threadId: input.threadId, createdAt: now })
        .pipe(
          Effect.mapError(repositoryError("thread link")),
          Effect.as(true),
          // A concurrent createThread won the insert; the dispatch above
          // deduped on the command receipt, so read back the winner's link.
          Effect.catch(() =>
            repository
              .getThreadLink({ threadId: input.threadId })
              .pipe(Effect.mapError(repositoryError("thread link")), Effect.map(Option.isSome)),
          ),
        );
      if (!stored) {
        return yield* notFound(
          `Personal bot thread '${input.threadId}' could not be read after creation.`,
        );
      }
      const link = yield* repository
        .getThreadLink({ threadId: input.threadId })
        .pipe(Effect.mapError(repositoryError("thread link")));
      if (Option.isNone(link)) {
        return yield* notFound(
          `Personal bot thread '${input.threadId}' could not be read after creation.`,
        );
      }
      return link.value;
    });

  const archiveThread: PersonalBotService["Service"]["archiveThread"] = (input) =>
    Effect.gen(function* () {
      const linked = yield* repository
        .getThreadLink({ threadId: input.threadId })
        .pipe(Effect.mapError(repositoryError("thread lookup")));
      if (Option.isNone(linked)) {
        return yield* notFound(`Personal bot thread '${input.threadId}' was not found.`);
      }
      const now = yield* DateTime.now;
      const updated = yield* repository
        .setThreadArchived({ threadId: input.threadId, archivedAt: input.archived ? now : null })
        .pipe(Effect.mapError(repositoryError("thread archive")));
      if (Option.isNone(updated)) {
        return yield* notFound(`Personal bot thread '${input.threadId}' was not found.`);
      }
      return updated.value;
    });

  return {
    list,
    create,
    update,
    remove,
    createThread,
    archiveThread,
    seedDefaultsIfNeeded,
  } satisfies PersonalBotService["Service"];
});

export const layer = Layer.effect(PersonalBotService, make);

export const PERSONAL_BOTS_SEED_META_KEY = PERSONAL_META_SEEDED;
export const PERSONAL_BOTS_PROJECT_META_KEY = PERSONAL_META_PROJECT_ID;
