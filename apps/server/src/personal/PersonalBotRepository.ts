import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  BotAvatarColor,
  BotAvatarShape,
  ChatAttachment,
  ModelSelection,
  PersonalBot,
  PersonalBotId,
  PersonalBotThread,
  ThreadId,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";

import {
  type PersonalBotRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "../persistence/Errors.ts";

export const CreatePersonalBotInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: ModelSelection,
  sortOrder: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CreatePersonalBotInput = typeof CreatePersonalBotInput.Type;

export const UpdatePersonalBotInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  avatarShape: Schema.optional(BotAvatarShape),
  avatarColor: Schema.optional(BotAvatarColor),
  modelSelection: Schema.optional(ModelSelection),
  enabled: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(Schema.Number),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type UpdatePersonalBotInput = typeof UpdatePersonalBotInput.Type;

export const GetPersonalBotByIdInput = Schema.Struct({
  botId: PersonalBotId,
});
export type GetPersonalBotByIdInput = typeof GetPersonalBotByIdInput.Type;

export const SoftDeletePersonalBotInput = Schema.Struct({
  botId: PersonalBotId,
  deletedAt: Schema.DateTimeUtcFromString,
});
export type SoftDeletePersonalBotInput = typeof SoftDeletePersonalBotInput.Type;

export const InsertPersonalBotThreadInput = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
});
export type InsertPersonalBotThreadInput = typeof InsertPersonalBotThreadInput.Type;

export const GetPersonalBotThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetPersonalBotThreadInput = typeof GetPersonalBotThreadInput.Type;

export const SetPersonalBotThreadArchivedInput = Schema.Struct({
  threadId: ThreadId,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type SetPersonalBotThreadArchivedInput = typeof SetPersonalBotThreadArchivedInput.Type;

export const GetPersonalMetaInput = Schema.Struct({
  key: Schema.String,
});
export type GetPersonalMetaInput = typeof GetPersonalMetaInput.Type;

export const SetPersonalMetaInput = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});
export type SetPersonalMetaInput = typeof SetPersonalMetaInput.Type;

export class PersonalBotRepository extends Context.Service<
  PersonalBotRepository,
  {
    readonly createBot: (
      input: CreatePersonalBotInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly getBotById: (
      input: GetPersonalBotByIdInput,
    ) => Effect.Effect<Option.Option<PersonalBot>, PersonalBotRepositoryError>;
    readonly listBots: () => Effect.Effect<ReadonlyArray<PersonalBot>, PersonalBotRepositoryError>;
    readonly updateBot: (
      input: UpdatePersonalBotInput,
    ) => Effect.Effect<Option.Option<PersonalBot>, PersonalBotRepositoryError>;
    readonly softDeleteBot: (
      input: SoftDeletePersonalBotInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly insertThreadLink: (
      input: InsertPersonalBotThreadInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly getThreadLink: (
      input: GetPersonalBotThreadInput,
    ) => Effect.Effect<Option.Option<PersonalBotThread>, PersonalBotRepositoryError>;
    readonly setThreadArchived: (
      input: SetPersonalBotThreadArchivedInput,
    ) => Effect.Effect<Option.Option<PersonalBotThread>, PersonalBotRepositoryError>;
    readonly listThreadLinks: () => Effect.Effect<
      ReadonlyArray<PersonalBotThread>,
      PersonalBotRepositoryError
    >;
    readonly getMeta: (
      input: GetPersonalMetaInput,
    ) => Effect.Effect<Option.Option<string>, PersonalBotRepositoryError>;
    readonly setMeta: (
      input: SetPersonalMetaInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    /**
     * Messages with attachments in threads linked to live (not deleted) bots,
     * newest first. Rows whose ids or attachment JSON fail to decode are
     * skipped so one bad message cannot hide every file.
     */
    readonly listThreadAttachments: () => Effect.Effect<
      ReadonlyArray<PersonalThreadAttachments>,
      PersonalBotRepositoryError
    >;
    /**
     * Bot instructions for a thread, for the provider session/turn path.
     * None when the thread has no bot link, the bot is soft-deleted, or its
     * instructions are blank.
     */
    readonly getInstructionsForThread: (
      input: GetPersonalBotThreadInput,
    ) => Effect.Effect<Option.Option<string>, PersonalBotRepositoryError>;
  }
>()("t3/personal/PersonalBotRepository") {}

const PersonalBotDbRow = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: Schema.fromJsonString(ModelSelection),
  enabled: Schema.Number,
  sortOrder: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const PersonalBotRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  name: Schema.Unknown,
  title: Schema.Unknown,
  description: Schema.Unknown,
  instructions: Schema.Unknown,
  avatarShape: Schema.Unknown,
  avatarColor: Schema.Unknown,
  modelSelection: Schema.Unknown,
  enabled: Schema.Unknown,
  sortOrder: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
  deletedAt: Schema.Unknown,
});

const PersonalBotThreadDbRow = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const PersonalBotThreadRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  threadId: Schema.Unknown,
  createdAt: Schema.Unknown,
  archivedAt: Schema.Unknown,
});

const PersonalMetaDbRow = Schema.Struct({
  value: Schema.String,
});

export interface PersonalThreadAttachments {
  readonly botId: PersonalBotId;
  readonly threadId: ThreadId;
  readonly createdAt: typeof Schema.DateTimeUtcFromString.Type;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

const PersonalThreadAttachmentsDbRow = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
});

const PersonalThreadAttachmentsRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  threadId: Schema.Unknown,
  createdAt: Schema.Unknown,
  attachments: Schema.Unknown,
});

const decodePersonalThreadAttachmentsDbRow = Schema.decodeUnknownOption(
  PersonalThreadAttachmentsDbRow,
);

const decodePersonalBotDbRow = Schema.decodeUnknownEffect(PersonalBotDbRow);
const decodePersonalBotThreadDbRow = Schema.decodeUnknownEffect(PersonalBotThreadDbRow);

function toPersonalBot(row: typeof PersonalBotDbRow.Type): PersonalBot {
  return {
    botId: row.botId,
    name: row.name,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    avatarShape: row.avatarShape,
    avatarColor: row.avatarColor,
    modelSelection: row.modelSelection as ModelSelectionType,
    enabled: row.enabled === 1,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersonalBotThread(row: typeof PersonalBotThreadDbRow.Type): PersonalBotThread {
  return {
    botId: row.botId,
    threadId: row.threadId,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): PersonalBotRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createBotRow = SqlSchema.void({
    Request: CreatePersonalBotInput,
    execute: (input) =>
      sql`
        INSERT INTO personal_bots (
          bot_id,
          name,
          title,
          description,
          instructions,
          avatar_shape,
          avatar_color,
          model_selection_json,
          enabled,
          sort_order,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${input.botId},
          ${input.name},
          ${input.title},
          ${input.description},
          ${input.instructions},
          ${input.avatarShape},
          ${input.avatarColor},
          ${JSON.stringify(input.modelSelection)},
          1,
          ${input.sortOrder},
          ${input.createdAt},
          ${input.updatedAt},
          NULL
        )
      `,
  });

  const getBotRowById = SqlSchema.findOneOption({
    Request: GetPersonalBotByIdInput,
    Result: PersonalBotRawDbRow,
    execute: ({ botId }) =>
      sql`
        SELECT
          bot_id AS "botId",
          name AS "name",
          title AS "title",
          description AS "description",
          instructions AS "instructions",
          avatar_shape AS "avatarShape",
          avatar_color AS "avatarColor",
          model_selection_json AS "modelSelection",
          enabled AS "enabled",
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM personal_bots
        WHERE bot_id = ${botId}
      `,
  });

  const listBotRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersonalBotRawDbRow,
    execute: () =>
      sql`
        SELECT
          bot_id AS "botId",
          name AS "name",
          title AS "title",
          description AS "description",
          instructions AS "instructions",
          avatar_shape AS "avatarShape",
          avatar_color AS "avatarColor",
          model_selection_json AS "modelSelection",
          enabled AS "enabled",
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM personal_bots
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, bot_id ASC
      `,
  });

  const updateBotRow = SqlSchema.findOneOption({
    Request: UpdatePersonalBotInput,
    Result: PersonalBotRawDbRow,
    execute: (input) =>
      sql`
        UPDATE personal_bots
        SET name = COALESCE(${input.name ?? null}, name),
            title = COALESCE(${input.title ?? null}, title),
            description = COALESCE(${input.description ?? null}, description),
            instructions = COALESCE(${input.instructions ?? null}, instructions),
            avatar_shape = COALESCE(${input.avatarShape ?? null}, avatar_shape),
            avatar_color = COALESCE(${input.avatarColor ?? null}, avatar_color),
            model_selection_json = COALESCE(
              ${input.modelSelection === undefined ? null : JSON.stringify(input.modelSelection)},
              model_selection_json
            ),
            enabled = COALESCE(${input.enabled === undefined ? null : input.enabled ? 1 : 0}, enabled),
            sort_order = COALESCE(${input.sortOrder ?? null}, sort_order),
            updated_at = ${input.updatedAt}
        WHERE bot_id = ${input.botId}
        RETURNING
          bot_id AS "botId",
          name AS "name",
          title AS "title",
          description AS "description",
          instructions AS "instructions",
          avatar_shape AS "avatarShape",
          avatar_color AS "avatarColor",
          model_selection_json AS "modelSelection",
          enabled AS "enabled",
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
      `,
  });

  const softDeleteBotRow = SqlSchema.void({
    Request: SoftDeletePersonalBotInput,
    execute: ({ botId, deletedAt }) =>
      sql`
        UPDATE personal_bots
        SET deleted_at = ${deletedAt}
        WHERE bot_id = ${botId}
          AND deleted_at IS NULL
      `,
  });

  const insertThreadLinkRow = SqlSchema.void({
    Request: InsertPersonalBotThreadInput,
    execute: (input) =>
      sql`
        INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at)
        VALUES (${input.threadId}, ${input.botId}, ${input.createdAt}, NULL)
      `,
  });

  const getThreadLinkRow = SqlSchema.findOneOption({
    Request: GetPersonalBotThreadInput,
    Result: PersonalBotThreadRawDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          bot_id AS "botId",
          thread_id AS "threadId",
          created_at AS "createdAt",
          archived_at AS "archivedAt"
        FROM personal_bot_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const setThreadArchivedRow = SqlSchema.findOneOption({
    Request: SetPersonalBotThreadArchivedInput,
    Result: PersonalBotThreadRawDbRow,
    execute: ({ threadId, archivedAt }) =>
      sql`
        UPDATE personal_bot_threads
        SET archived_at = ${archivedAt}
        WHERE thread_id = ${threadId}
        RETURNING
          bot_id AS "botId",
          thread_id AS "threadId",
          created_at AS "createdAt",
          archived_at AS "archivedAt"
      `,
  });

  const listThreadLinkRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersonalBotThreadRawDbRow,
    execute: () =>
      sql`
        SELECT
          bot_id AS "botId",
          thread_id AS "threadId",
          created_at AS "createdAt",
          archived_at AS "archivedAt"
        FROM personal_bot_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const getMetaRow = SqlSchema.findOneOption({
    Request: GetPersonalMetaInput,
    Result: PersonalMetaDbRow,
    execute: ({ key }) =>
      sql`
        SELECT value AS "value"
        FROM personal_meta
        WHERE key = ${key}
      `,
  });

  const setMetaRow = SqlSchema.void({
    Request: SetPersonalMetaInput,
    execute: ({ key, value }) =>
      sql`
        INSERT INTO personal_meta (key, value)
        VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
  });

  const getInstructionsForThreadRow = SqlSchema.findOneOption({
    Request: GetPersonalBotThreadInput,
    Result: Schema.Struct({ instructions: Schema.String }),
    execute: ({ threadId }) =>
      sql`
        SELECT b.instructions AS "instructions"
        FROM personal_bot_threads t
        JOIN personal_bots b ON b.bot_id = t.bot_id
        WHERE t.thread_id = ${threadId}
          AND b.deleted_at IS NULL
      `,
  });

  const listThreadAttachmentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersonalThreadAttachmentsRawDbRow,
    execute: () =>
      sql`
        SELECT
          t.bot_id AS "botId",
          m.thread_id AS "threadId",
          m.created_at AS "createdAt",
          m.attachments_json AS "attachments"
        FROM personal_bot_threads t
        JOIN personal_bots b ON b.bot_id = t.bot_id AND b.deleted_at IS NULL
        JOIN projection_thread_messages m ON m.thread_id = t.thread_id
        WHERE m.attachments_json IS NOT NULL
          AND m.attachments_json <> '[]'
        ORDER BY m.created_at DESC, m.message_id DESC
      `,
  });

  const decodeBotRow = (
    operation: string,
    rowOption: Option.Option<typeof PersonalBotRawDbRow.Type>,
  ) =>
    Option.match(rowOption, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (row) =>
        decodePersonalBotDbRow(row).pipe(
          Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
          Effect.map((decoded) => Option.some(toPersonalBot(decoded))),
        ),
    });

  const decodeThreadRow = (
    operation: string,
    rowOption: Option.Option<typeof PersonalBotThreadRawDbRow.Type>,
  ) =>
    Option.match(rowOption, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (row) =>
        decodePersonalBotThreadDbRow(row).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError(operation, cause, {
              threadId: String(row.threadId),
            }),
          ),
          Effect.map((decoded) => Option.some(toPersonalBotThread(decoded))),
        ),
    });

  const createBot: PersonalBotRepository["Service"]["createBot"] = (input) =>
    createBotRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.createBot:query",
          "PersonalBotRepository.createBot:encodeRequest",
        ),
      ),
    );

  const getBotById: PersonalBotRepository["Service"]["getBotById"] = (input) =>
    getBotRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getBotById:query",
          "PersonalBotRepository.getBotById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        decodeBotRow("PersonalBotRepository.getBotById:decodeRow", rowOption),
      ),
    );

  const listBots: PersonalBotRepository["Service"]["listBots"] = () =>
    listBotRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listBots:query",
          "PersonalBotRepository.listBots:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePersonalBotDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "PersonalBotRepository.listBots:decodeRows",
                cause,
              ),
            ),
            Effect.map(toPersonalBot),
          ),
        ),
      ),
    );

  const updateBot: PersonalBotRepository["Service"]["updateBot"] = (input) =>
    updateBotRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.updateBot:query",
          "PersonalBotRepository.updateBot:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        decodeBotRow("PersonalBotRepository.updateBot:decodeRow", rowOption),
      ),
    );

  const softDeleteBot: PersonalBotRepository["Service"]["softDeleteBot"] = (input) =>
    softDeleteBotRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.softDeleteBot:query",
          "PersonalBotRepository.softDeleteBot:encodeRequest",
        ),
      ),
    );

  const insertThreadLink: PersonalBotRepository["Service"]["insertThreadLink"] = (input) =>
    insertThreadLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.insertThreadLink:query",
          "PersonalBotRepository.insertThreadLink:encodeRequest",
        ),
      ),
    );

  const getThreadLink: PersonalBotRepository["Service"]["getThreadLink"] = (input) =>
    getThreadLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getThreadLink:query",
          "PersonalBotRepository.getThreadLink:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        decodeThreadRow("PersonalBotRepository.getThreadLink:decodeRow", rowOption),
      ),
    );

  const setThreadArchived: PersonalBotRepository["Service"]["setThreadArchived"] = (input) =>
    setThreadArchivedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.setThreadArchived:query",
          "PersonalBotRepository.setThreadArchived:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        decodeThreadRow("PersonalBotRepository.setThreadArchived:decodeRow", rowOption),
      ),
    );

  const listThreadLinks: PersonalBotRepository["Service"]["listThreadLinks"] = () =>
    listThreadLinkRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listThreadLinks:query",
          "PersonalBotRepository.listThreadLinks:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePersonalBotThreadDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "PersonalBotRepository.listThreadLinks:decodeRows",
                cause,
              ),
            ),
            Effect.map(toPersonalBotThread),
          ),
        ),
      ),
    );

  const getMeta: PersonalBotRepository["Service"]["getMeta"] = (input) =>
    getMetaRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getMeta:query",
          "PersonalBotRepository.getMeta:decodeRow",
        ),
      ),
      Effect.map(Option.map((row) => row.value)),
    );

  const setMeta: PersonalBotRepository["Service"]["setMeta"] = (input) =>
    setMetaRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.setMeta:query",
          "PersonalBotRepository.setMeta:encodeRequest",
        ),
      ),
    );

  const getInstructionsForThread: PersonalBotRepository["Service"]["getInstructionsForThread"] = (
    input,
  ) =>
    getInstructionsForThreadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getInstructionsForThread:query",
          "PersonalBotRepository.getInstructionsForThread:decodeRow",
        ),
      ),
      Effect.map(
        Option.flatMap((row) => {
          const trimmed = row.instructions.trim();
          return trimmed.length > 0 ? Option.some(row.instructions) : Option.none();
        }),
      ),
    );

  const listThreadAttachments: PersonalBotRepository["Service"]["listThreadAttachments"] = () =>
    listThreadAttachmentRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listThreadAttachments:query",
          "PersonalBotRepository.listThreadAttachments:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.flatMap((row) => Option.toArray(decodePersonalThreadAttachmentsDbRow(row))),
      ),
    );

  return {
    createBot,
    getBotById,
    listBots,
    updateBot,
    softDeleteBot,
    insertThreadLink,
    getThreadLink,
    setThreadArchived,
    listThreadLinks,
    getMeta,
    setMeta,
    getInstructionsForThread,
    listThreadAttachments,
  } satisfies PersonalBotRepository["Service"];
});

export const layer = Layer.effect(PersonalBotRepository, make);
