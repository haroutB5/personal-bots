import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import {
  botTeam,
  CommandId,
  DEFAULT_PERSONAL_BOT_TEAM,
  driverCarriesBotInstructions,
  isBotOnTeam,
  isProviderAvailable,
  PersonalBotId,
  PERSONAL_BOT_MUTED_INDEFINITELY_ISO,
  PersonalBotTeam,
  PersonalBotsError,
  PersonalBotThread,
  PERSONAL_BOT_TEAM_ORDER,
  personalBotTeamLabel,
  ProjectId,
  sameTeam,
  ProviderDriverKind,
  ThreadId,
  type PersonalBot,
  type PersonalBotCreateInput,
  type PersonalBotNotificationMute,
  type PersonalBotsListResult,
  type PersonalBotUpdateInput,
  type PersonalFile,
  type PersonalProfile,
  type PersonalProfileSetInput,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import { withGroupPresence } from "./groupOnlyBots.ts";
import { PERSONAL_THREAD_TITLE } from "./personalThreadTitles.ts";

const PERSONAL_META_SEEDED = "seeded";
const PERSONAL_META_PROJECT_ID = "personalProjectId";
const PERSONAL_META_DISPLAY_NAME = "displayName";
const decodeCustomTeams = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PersonalBotTeam)),
);
const encodeCustomTeams = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(PersonalBotTeam)));
const PERSONAL_PROFILE_DISPLAY_NAME_MAX_LENGTH = 80;
const PERSONAL_WORKSPACE_DIRNAME = "personal-workspace";
const PERSONAL_PROJECT_TITLE = "Personal";

/**
 * The stored mute time a mute request stands for, from the server's clock:
 * null is on, the far-future time is "until I turn it back on".
 */
export function notificationsMutedUntilFor(
  mute: PersonalBotNotificationMute,
  now: DateTime.Utc,
): DateTime.Utc | null {
  if (mute === "on") return null;
  if (mute === "indefinitely") return DateTime.makeUnsafe(PERSONAL_BOT_MUTED_INDEFINITELY_ISO);
  return DateTime.add(now, { minutes: mute.forMinutes });
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface SeedBotDefinition {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly avatarShape: PersonalBot["avatarShape"];
  readonly avatarColor: string;
  readonly driver: typeof CLAUDE_DRIVER | typeof CODEX_DRIVER;
  readonly team: PersonalBotTeam;
  /** The team's lead, which is also pinned to the top of Chats. */
  readonly lead: boolean;
}

const SEED_BOT_DEFINITIONS: ReadonlyArray<SeedBotDefinition> = [
  {
    key: "assistant",
    name: "Assistant",
    title: "Personal assistant",
    description: "Understands requests, organizes work, delegates and reviews results.",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    driver: CLAUDE_DRIVER,
    team: "assistant",
    lead: true,
  },
  {
    key: "developer",
    name: "Developer",
    title: "Engineer",
    description: "Implements, tests and returns reviewable changes.",
    avatarShape: "roundedHexagon",
    avatarColor: "#F26A1B",
    driver: CODEX_DRIVER,
    team: "assistant",
    lead: false,
  },
  {
    key: "researcher",
    name: "Researcher",
    title: "Research analyst",
    description: "Researches, compares options and returns sources.",
    avatarShape: "scallopedCloud",
    avatarColor: "#F0457E",
    driver: CODEX_DRIVER,
    team: "assistant",
    lead: false,
  },
  {
    key: "planner",
    name: "Planner",
    title: "Planner",
    description: "Prepares plans and manages routines.",
    avatarShape: "roundedSquare",
    avatarColor: "#E5323B",
    driver: CLAUDE_DRIVER,
    team: "assistant",
    lead: false,
  },
];

const seedBotId = (key: string): PersonalBotId =>
  // Deterministic ids keep a retried seed from duplicating bots: the flag is
  // the primary guard, the id is the backstop.
  PersonalBotId.make(`personal-seed-${key}`);

const toPersonalBotsError = (message: string) => (cause: unknown) =>
  new PersonalBotsError({ message, cause });

/** A Files-tab row before its URLs are signed (see `PersonalFiles.ts`). */
export type PersonalFileRecord = Omit<PersonalFile, "url" | "previewUrl" | "expiresAt">;

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
    /**
     * Creates the bot's thread, or returns its link when it already exists.
     * `title` names a thread this call creates (a task or routine run's own
     * chat); an existing thread keeps its title. Default: the placeholder.
     */
    readonly createThread: (input: {
      readonly botId: PersonalBotId;
      readonly threadId: ThreadId;
      readonly title?: string;
    }) => Effect.Effect<PersonalBotThread, PersonalBotsError>;
    /**
     * Creates a thread in the Personal project with NO bot-thread link row.
     *
     * This is how a group's shared transcript thread is made. The missing link
     * row is the whole point: persona injection, per-bot memory and the MCP
     * "who am I" lookup all key off `personal_bot_threads`, so a thread without
     * one belongs to no bot and no provider ever runs on it.
     */
    readonly createSharedThread: (input: {
      readonly threadId: ThreadId;
      readonly title: string;
      /** Required by `thread.create`; unused, since no turn ever starts here. */
      readonly modelSelection: PersonalBot["modelSelection"];
    }) => Effect.Effect<ThreadId, PersonalBotsError>;
    readonly archiveThread: (input: {
      readonly threadId: ThreadId;
      readonly archived: boolean;
    }) => Effect.Effect<PersonalBotThread, PersonalBotsError>;
    /**
     * Permanently deletes exactly one chat: the orchestration thread plus
     * its bot-thread link row. Bot-level data (bot row, memories, secrets,
     * routines, tasks) is untouched — call `deletePersonalChat` instead of
     * this method from a request path, so the tasks still bound to the thread
     * are cancelled first and cannot re-run a turn on the tombstone.
     */
    readonly deleteThread: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, PersonalBotsError>;
    readonly getProfile: () => Effect.Effect<PersonalProfile, PersonalBotsError>;
    readonly setProfile: (
      input: PersonalProfileSetInput,
    ) => Effect.Effect<PersonalProfile, PersonalBotsError>;
    readonly seedDefaultsIfNeeded: Effect.Effect<ReadonlyArray<PersonalBot>, PersonalBotsError>;
    /** Attachments from live bots' threads that still exist on disk, newest first. */
    readonly listFiles: () => Effect.Effect<ReadonlyArray<PersonalFileRecord>, PersonalBotsError>;
    /** Permanently removes one attachment owned by a live personal-bot thread. */
    readonly deleteFile: (input: {
      readonly fileId: string;
    }) => Effect.Effect<void, PersonalBotsError>;
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
  const profileLock = yield* Semaphore.make(1);
  // A corrupt customTeams row is reported once per process, not once per
  // profile read: the Chats screen polls this and would otherwise flood the log.
  let customTeamsDecodeLogged = false;

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
        (snapshot) =>
          isProviderAvailable(snapshot) &&
          snapshot.enabled &&
          snapshot.installed &&
          // Seeding onto a provider whose adapter drops `systemInstructions`
          // would hand the owner bots that answer as the bare model, with no
          // name and none of the app rules. Better no seed than a mute one:
          // the flag stays unset below, so a later boot seeds properly.
          driverCarriesBotInstructions(snapshot.driver),
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
            title: definition.title,
            // The description doubles as the starting bot instruction.
            description: definition.description,
            instructions: definition.description,
            avatarShape: definition.avatarShape,
            avatarColor: definition.avatarColor,
            modelSelection: {
              instanceId: instance.instanceId,
              model,
            },
            team: definition.team,
            lead: definition.lead,
            pinned: definition.lead,
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
      const [bots, threads, storedProjectId, groupPresence] = yield* Effect.all([
        repository.listBots().pipe(Effect.mapError(repositoryError("list"))),
        repository.listThreadLinks().pipe(Effect.mapError(repositoryError("list"))),
        repository
          .getMeta({ key: PERSONAL_META_PROJECT_ID })
          .pipe(Effect.mapError(repositoryError("list"))),
        // Hiding is a nicety; a failure here must show every bot, never hide one.
        repository.listGroupPresence().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Personal bots group presence failed; listing every bot.", {
              cause,
            }).pipe(Effect.as([])),
          ),
        ),
      ]);
      return {
        bots: withGroupPresence(bots, groupPresence),
        threads: [...threads],
        personalProjectId: Option.isSome(storedProjectId)
          ? ProjectId.make(storedProjectId.value)
          : null,
      } satisfies PersonalBotsListResult;
    });

  /**
   * Resolves a team named on a bot to a team that exists: a built-in, or a
   * custom team the user registered. Without this, `personalBots.create` and
   * `.update` accept any 60-character string, and a typo mints a phantom team
   * that the team diagram draws but Manage teams cannot remove.
   *
   * The registered spelling is returned, so a case variant is filed under the
   * team it names instead of becoming a second band in the diagram. Existing
   * rows are never rewritten; {@link isBotOnTeam} is what reads those.
   */
  const requireKnownTeam = (team: PersonalBotTeam) =>
    Effect.gen(function* () {
      const profile = yield* getProfile();
      const known = [...PERSONAL_BOT_TEAM_ORDER, ...(profile.customTeams ?? [])];
      const match = known.find(
        (candidate) =>
          sameTeam(candidate, team) ||
          personalBotTeamLabel(candidate).toLowerCase() === team.trim().toLowerCase(),
      );
      if (match === undefined) {
        return yield* notFound(
          `'${team}' is not a team. Known teams: ${known.map(personalBotTeamLabel).join(", ")}.`,
        );
      }
      return match;
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
      // A bot with no team named joins the assistant's team as a member; a
      // team that was named has to be one that exists.
      const team = yield* requireKnownTeam(input.team ?? DEFAULT_PERSONAL_BOT_TEAM);
      const lead = input.lead ?? false;
      yield* repository
        .createBot({
          ...input,
          title: input.title?.trim() ?? "",
          team,
          lead,
          pinned: input.pinned ?? false,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .pipe(Effect.mapError(repositoryError("create")));
      // One lead per team: the bot just made lead displaces the previous one.
      if (lead) {
        yield* repository
          .clearTeamLead({ team, exceptBotId: input.botId, updatedAt: now })
          .pipe(Effect.mapError(repositoryError("create")));
      }
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
      // Same rule as create, so the drag-and-drop path on the team diagram and
      // any API caller land on a team that exists.
      const team = input.team === undefined ? undefined : yield* requireKnownTeam(input.team);
      const { notificationsMute, ...fields } = input;
      const updated = yield* repository
        .updateBot({
          ...fields,
          ...(notificationsMute === undefined
            ? {}
            : { notificationsMutedUntil: notificationsMutedUntilFor(notificationsMute, now) }),
          ...(team === undefined ? {} : { team }),
          ...(input.title === undefined ? {} : { title: input.title.trim() }),
          updatedAt: now,
        })
        .pipe(Effect.mapError(repositoryError("update")));
      if (Option.isNone(updated)) {
        return yield* notFound(`Personal bot '${input.botId}' was not found.`);
      }
      // One lead per team, read from the row as it now stands: a bot that
      // changed team in this same call leads the team it landed on.
      if (input.lead === true) {
        yield* repository
          .clearTeamLead({
            team: botTeam(updated.value),
            exceptBotId: input.botId,
            updatedAt: now,
          })
          .pipe(Effect.mapError(repositoryError("update")));
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
          title: input.title?.trim() || PERSONAL_THREAD_TITLE,
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

  const createSharedThread: PersonalBotService["Service"]["createSharedThread"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* snapshots
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(repositoryError("thread lookup")));
      if (Option.isSome(existing)) {
        return input.threadId;
      }
      const projectId = yield* ensurePersonalProject();
      yield* engine
        .dispatch({
          type: "thread.create",
          // Deterministic per thread, as `createThread` is: a retried create
          // dedupes on the command receipt rather than making a second thread.
          commandId: CommandId.make(`personal-bots:thread.create:${input.threadId}`),
          threadId: input.threadId,
          projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.mapError(toPersonalBotsError("Personal bots thread creation failed.")));
      return input.threadId;
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

  const deleteThread: PersonalBotService["Service"]["deleteThread"] = (input) =>
    Effect.gen(function* () {
      const linked = yield* repository
        .getThreadLink({ threadId: input.threadId })
        .pipe(Effect.mapError(repositoryError("thread lookup")));
      if (Option.isNone(linked)) {
        return yield* notFound(`Personal bot thread '${input.threadId}' was not found.`);
      }
      yield* engine
        .dispatch({
          type: "thread.delete",
          // Same deterministic id the bot purge uses, so a retried delete
          // reuses the command receipt instead of deleting twice.
          commandId: CommandId.make(`personal-bots:thread.delete:${input.threadId}`),
          threadId: input.threadId,
        })
        .pipe(Effect.mapError(toPersonalBotsError("Personal bots thread deletion failed.")));
      // The link row goes only after the thread is gone: a dispatch failure
      // keeps the chat listed so the user can retry.
      yield* repository
        .deleteThreadLink({ threadId: input.threadId })
        .pipe(Effect.mapError(repositoryError("thread delete")));
    });

  // The Chats greeting name. Unset (no row yet) reads back as "" so the
  // client can omit the name instead of inventing one.
  const getProfile: PersonalBotService["Service"]["getProfile"] = () =>
    Effect.gen(function* () {
      const stored = yield* repository.getMeta({ key: PERSONAL_META_DISPLAY_NAME });
      const teams = yield* repository.getMeta({ key: "customTeams" });
      // An undecodable customTeams row reads as "no custom teams" rather than
      // failing the whole profile: the greeting name is stored separately and
      // must keep working. Manage teams then offers only the built-ins, and
      // the next team change rewrites the row.
      const customTeams: ReadonlyArray<PersonalBotTeam> = Option.isSome(teams)
        ? yield* decodeCustomTeams(teams.value).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (!customTeamsDecodeLogged) {
                  customTeamsDecodeLogged = true;
                  yield* Effect.logWarning(
                    "Stored personal custom teams could not be decoded; serving the profile without them.",
                    cause,
                  );
                }
                return [] as ReadonlyArray<PersonalBotTeam>;
              }),
            ),
          )
        : [];
      return {
        displayName: Option.getOrElse(stored, () => ""),
        ...(customTeams.length > 0 ? { customTeams } : {}),
      };
    }).pipe(Effect.mapError(repositoryError("profile lookup")));

  const setProfile: PersonalBotService["Service"]["setProfile"] = (input) =>
    Effect.gen(function* () {
      const profile = yield* getProfile();
      const displayName = input.displayName?.trim() ?? profile.displayName;
      if (displayName.length > PERSONAL_PROFILE_DISPLAY_NAME_MAX_LENGTH) {
        return yield* notFound(
          `Personal profile display name must be at most ${PERSONAL_PROFILE_DISPLAY_NAME_MAX_LENGTH} characters.`,
        );
      }
      if (input.teamChange !== undefined) {
        const name = input.teamChange.name.trim();
        if (name.length === 0 || name.length > 60) {
          return yield* notFound("Team names must be between 1 and 60 characters.");
        }
        const customTeams = [...(profile.customTeams ?? [])];
        const key = name.toLowerCase();
        if (
          PERSONAL_BOT_TEAM_ORDER.some(
            (team) => team === key || personalBotTeamLabel(team).toLowerCase() === key,
          )
        ) {
          return yield* notFound("The built-in teams already exist and cannot be removed.");
        }
        const existing = customTeams.find((team) => team.toLowerCase() === key);
        if (input.teamChange.operation === "create") {
          if (existing === undefined) customTeams.push(name);
        } else {
          const bots = yield* repository
            .listBots()
            .pipe(Effect.mapError(repositoryError("team lookup")));
          // Case-insensitive, exactly like the duplicate check above: a bot
          // stored as "RESEARCH" is on "Research", so removing the team would
          // strand it. The Team screen counts members the same way.
          if (bots.some((bot) => isBotOnTeam(bot, existing ?? name))) {
            return yield* notFound("Move the team's bots to another team before removing it.");
          }
          if (existing !== undefined) customTeams.splice(customTeams.indexOf(existing), 1);
        }
        const value = yield* encodeCustomTeams(customTeams).pipe(
          Effect.mapError(repositoryError("team encoding")),
        );
        yield* repository
          .setMeta({ key: "customTeams", value })
          .pipe(Effect.mapError(repositoryError("team update")));
      }
      yield* repository
        .setMeta({ key: PERSONAL_META_DISPLAY_NAME, value: displayName })
        .pipe(Effect.mapError(repositoryError("profile update")));
      return yield* getProfile();
    }).pipe(profileLock.withPermits(1));

  const listFiles: PersonalBotService["Service"]["listFiles"] = () =>
    Effect.gen(function* () {
      const rows = yield* repository
        .listThreadAttachments()
        .pipe(Effect.mapError(repositoryError("files")));
      const seen = new Set<string>();
      const files: Array<PersonalFileRecord> = [];
      for (const row of rows) {
        const threadSegment = toSafeThreadAttachmentSegment(row.threadId);
        for (const attachment of row.attachments) {
          if (attachment.type !== "image" && attachment.type !== "file") continue;
          if (seen.has(attachment.id)) continue;
          // Stored attachment ids are minted for the thread that claimed them.
          // An id naming another thread is not this bot's file, so it is not
          // listed even though a personal message references it.
          if (
            threadSegment === null ||
            parseThreadSegmentFromAttachmentId(attachment.id) !== threadSegment
          ) {
            continue;
          }
          // Id-only lookup confined to the attachments directory; a file that
          // was removed or expired is not offered.
          if (
            resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: attachment.id,
            }) === null
          ) {
            continue;
          }
          seen.add(attachment.id);
          files.push({
            fileId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            botId: row.botId,
            threadId: row.threadId,
            createdAt: row.createdAt,
          });
        }
      }
      return files as ReadonlyArray<PersonalFileRecord>;
    });

  const deleteFile: PersonalBotService["Service"]["deleteFile"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* repository
        .listThreadAttachments()
        .pipe(Effect.mapError(repositoryError("files")));
      const owned = rows.some((row) => {
        const threadSegment = toSafeThreadAttachmentSegment(row.threadId);
        return row.attachments.some(
          (attachment) =>
            (attachment.type === "image" || attachment.type === "file") &&
            attachment.id === input.fileId &&
            threadSegment !== null &&
            parseThreadSegmentFromAttachmentId(attachment.id) === threadSegment,
        );
      });
      if (!owned) {
        return yield* notFound(`Personal file '${input.fileId}' was not found.`);
      }

      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.fileId,
      });
      // The surviving message reference is the idempotency record. A retry
      // after the blob was removed is still successful, while an arbitrary id
      // was rejected by the ownership check above.
      if (attachmentPath === null) return;
      yield* fs
        .remove(attachmentPath, { force: true })
        .pipe(Effect.mapError(toPersonalBotsError("Personal file deletion failed.")));
    });

  return {
    list,
    create,
    update,
    remove,
    createThread,
    createSharedThread,
    archiveThread,
    deleteThread,
    getProfile,
    setProfile,
    seedDefaultsIfNeeded,
    listFiles,
    deleteFile,
  } satisfies PersonalBotService["Service"];
});

export const layer = Layer.effect(PersonalBotService, make);

export const PERSONAL_BOTS_SEED_META_KEY = PERSONAL_META_SEEDED;
export const PERSONAL_BOTS_PROJECT_META_KEY = PERSONAL_META_PROJECT_ID;
