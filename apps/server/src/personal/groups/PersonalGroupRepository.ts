import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import {
  MessageId,
  NonNegativeInt,
  PersonalBotId,
  PersonalGroupId,
  PersonalGroupMemberRole,
  PersonalGroupRoundId,
  PersonalGroupRoundStatus,
  ThreadId,
  TurnId,
  type PersonalGroupMember,
  type PersonalGroupRound,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type PersonalGroupRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** The `personal_groups` row; members are read separately. */
export interface PersonalGroupRecord {
  readonly groupId: PersonalGroupId;
  readonly name: string;
  readonly description: string;
  readonly threadId: ThreadId;
  readonly maxBotTurns: number;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
  readonly archivedAt: DateTime.Utc | null;
}

/**
 * A round plus the columns a client has no use for. The lease and the active
 * turn id stay server-side deliberately: exposing a lease invites a client to
 * reason about it (Phase 0, decision 6).
 */
export interface PersonalGroupRoundRecord extends PersonalGroupRound {
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: DateTime.Utc | null;
  readonly activeTurnId: TurnId | null;
}

/** One row of `personal_group_messages`: order and attribution, never text. */
export interface PersonalGroupMessageRecord {
  readonly seq: number;
  readonly groupId: PersonalGroupId;
  readonly messageId: MessageId;
  readonly speakerKind: "user" | "bot" | "system";
  readonly speakerBotId: PersonalBotId | null;
  readonly roundId: PersonalGroupRoundId | null;
  readonly createdAt: DateTime.Utc;
}

/** Rounds a client still has to care about, replayed on subscribe. */
export const PERSONAL_GROUP_LIVE_ROUND_STATUSES = [
  "running",
  "paused_budget",
  "paused_vote",
  "waiting_provider",
] as const;

const GroupDbRow = Schema.Struct({
  groupId: PersonalGroupId,
  name: Schema.String,
  description: Schema.String,
  threadId: ThreadId,
  maxBotTurns: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const MemberDbRow = Schema.Struct({
  groupId: PersonalGroupId,
  botId: PersonalBotId,
  threadId: Schema.NullOr(ThreadId),
  role: PersonalGroupMemberRole,
  sortOrder: Schema.Number,
  deliveredSeq: NonNegativeInt,
  joinedAt: Schema.DateTimeUtcFromString,
  leftAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const RoundDbRow = Schema.Struct({
  roundId: PersonalGroupRoundId,
  groupId: PersonalGroupId,
  triggerMessageId: MessageId,
  status: PersonalGroupRoundStatus,
  budgetRemaining: NonNegativeInt,
  queue: Schema.fromJsonString(Schema.Array(PersonalBotId)),
  spoken: Schema.fromJsonString(Schema.Array(PersonalBotId)),
  activeBotId: Schema.NullOr(PersonalBotId),
  activeThreadId: Schema.NullOr(ThreadId),
  activeTurnId: Schema.NullOr(TurnId),
  activeMessageId: Schema.NullOr(MessageId),
  relayedChars: NonNegativeInt,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  availableAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  deadlineAt: Schema.DateTimeUtcFromString,
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const MessageDbRow = Schema.Struct({
  seq: Schema.Number,
  groupId: PersonalGroupId,
  messageId: MessageId,
  speakerKind: Schema.Literals(["user", "bot", "system"]),
  speakerBotId: Schema.NullOr(PersonalBotId),
  roundId: Schema.NullOr(PersonalGroupRoundId),
  createdAt: Schema.DateTimeUtcFromString,
});

const isSqlError = Schema.is(SqlError.SqlError);
const decodeGroupRow = Schema.decodeUnknownEffect(GroupDbRow);
const decodeMemberRow = Schema.decodeUnknownEffect(MemberDbRow);
const decodeRoundRow = Schema.decodeUnknownEffect(RoundDbRow);
const decodeMessageRow = Schema.decodeUnknownEffect(MessageDbRow);

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);
const isoOrNull = (value: DateTime.Utc | null) => (value === null ? null : iso(value));

const GROUP_COLUMNS = `
  group_id AS "groupId",
  name AS "name",
  description AS "description",
  thread_id AS "threadId",
  max_bot_turns AS "maxBotTurns",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  archived_at AS "archivedAt"
`;

const MEMBER_COLUMNS = `
  group_id AS "groupId",
  bot_id AS "botId",
  thread_id AS "threadId",
  role AS "role",
  sort_order AS "sortOrder",
  delivered_seq AS "deliveredSeq",
  joined_at AS "joinedAt",
  left_at AS "leftAt"
`;

const ROUND_COLUMNS = `
  round_id AS "roundId",
  group_id AS "groupId",
  trigger_message_id AS "triggerMessageId",
  status AS "status",
  budget_remaining AS "budgetRemaining",
  queue_json AS "queue",
  spoken_json AS "spoken",
  active_bot_id AS "activeBotId",
  active_thread_id AS "activeThreadId",
  active_turn_id AS "activeTurnId",
  active_message_id AS "activeMessageId",
  relayed_chars AS "relayedChars",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  available_at AS "availableAt",
  deadline_at AS "deadlineAt",
  error_message AS "errorMessage",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MESSAGE_COLUMNS = `
  seq AS "seq",
  group_id AS "groupId",
  message_id AS "messageId",
  speaker_kind AS "speakerKind",
  speaker_bot_id AS "speakerBotId",
  round_id AS "roundId",
  created_at AS "createdAt"
`;

export class PersonalGroupRepository extends Context.Service<
  PersonalGroupRepository,
  {
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PersonalGroupRepositoryError, R>;

    /** Inserts unless the group id exists. Returns whether it inserted. */
    readonly insertGroup: (
      group: PersonalGroupRecord,
    ) => Effect.Effect<boolean, PersonalGroupRepositoryError>;
    readonly getGroup: (
      groupId: PersonalGroupId,
    ) => Effect.Effect<Option.Option<PersonalGroupRecord>, PersonalGroupRepositoryError>;
    readonly getGroupByThreadId: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersonalGroupRecord>, PersonalGroupRepositoryError>;
    /** Every group that has not been soft-deleted, newest first. */
    readonly listGroups: () => Effect.Effect<
      ReadonlyArray<PersonalGroupRecord>,
      PersonalGroupRepositoryError
    >;
    readonly writeGroup: (
      group: PersonalGroupRecord,
    ) => Effect.Effect<void, PersonalGroupRepositoryError>;
    readonly softDeleteGroup: (input: {
      readonly groupId: PersonalGroupId;
      readonly deletedAt: DateTime.Utc;
    }) => Effect.Effect<void, PersonalGroupRepositoryError>;

    readonly insertMember: (
      member: PersonalGroupMember,
    ) => Effect.Effect<boolean, PersonalGroupRepositoryError>;
    readonly listMembers: (
      groupId: PersonalGroupId,
    ) => Effect.Effect<ReadonlyArray<PersonalGroupMember>, PersonalGroupRepositoryError>;
    readonly writeMember: (
      member: PersonalGroupMember,
    ) => Effect.Effect<void, PersonalGroupRepositoryError>;
    readonly removeMember: (input: {
      readonly groupId: PersonalGroupId;
      readonly botId: PersonalBotId;
    }) => Effect.Effect<void, PersonalGroupRepositoryError>;
    /** Every membership of `botId`, across groups. */
    readonly listMembershipsByBot: (
      botId: PersonalBotId,
    ) => Effect.Effect<ReadonlyArray<PersonalGroupMember>, PersonalGroupRepositoryError>;
    /** The membership whose member thread is `threadId`, if any. */
    readonly getMemberByThreadId: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersonalGroupMember>, PersonalGroupRepositoryError>;

    /** Appends a log row; the assigned `seq` is the SQLite rowid. */
    readonly insertMessage: (input: {
      readonly groupId: PersonalGroupId;
      readonly messageId: MessageId;
      readonly speakerKind: "user" | "bot" | "system";
      readonly speakerBotId: PersonalBotId | null;
      readonly roundId: PersonalGroupRoundId | null;
      readonly createdAt: DateTime.Utc;
    }) => Effect.Effect<PersonalGroupMessageRecord, PersonalGroupRepositoryError>;
    readonly getMessageByMessageId: (
      messageId: MessageId,
    ) => Effect.Effect<Option.Option<PersonalGroupMessageRecord>, PersonalGroupRepositoryError>;
    /**
     * The catch-up window. `seq` is the global rowid, so it is monotonic but
     * NOT contiguous inside one group: this is strictly `seq > afterSeq`, and
     * nothing anywhere may compute `seq + 1`.
     */
    readonly listMessagesAfter: (input: {
      readonly groupId: PersonalGroupId;
      readonly afterSeq: number;
    }) => Effect.Effect<ReadonlyArray<PersonalGroupMessageRecord>, PersonalGroupRepositoryError>;
    /** The newest logged `seq` in the group, or 0 when it has never spoken. */
    readonly latestSeq: (
      groupId: PersonalGroupId,
    ) => Effect.Effect<number, PersonalGroupRepositoryError>;
    /** Drops a reserved row whose turn produced nothing. */
    readonly deleteMessage: (
      messageId: MessageId,
    ) => Effect.Effect<void, PersonalGroupRepositoryError>;

    readonly insertRound: (
      round: PersonalGroupRoundRecord,
    ) => Effect.Effect<void, PersonalGroupRepositoryError>;
    readonly getRound: (
      roundId: PersonalGroupRoundId,
    ) => Effect.Effect<Option.Option<PersonalGroupRoundRecord>, PersonalGroupRepositoryError>;
    readonly writeRound: (
      round: PersonalGroupRoundRecord,
    ) => Effect.Effect<void, PersonalGroupRepositoryError>;
    /** The group's newest round whatever its status; Continue needs terminal ones too. */
    readonly latestRoundForGroup: (
      groupId: PersonalGroupId,
    ) => Effect.Effect<Option.Option<PersonalGroupRoundRecord>, PersonalGroupRepositoryError>;
    /** Every non-terminal round, oldest first: the sweep's and the replay's set. */
    readonly listLiveRounds: () => Effect.Effect<
      ReadonlyArray<PersonalGroupRoundRecord>,
      PersonalGroupRepositoryError
    >;
    /** The round whose active member thread is `threadId`, if any. */
    readonly getRoundByActiveThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersonalGroupRoundRecord>, PersonalGroupRepositoryError>;
    readonly heartbeat: (input: {
      readonly leaseOwner: string;
      readonly now: DateTime.Utc;
      readonly leaseExpiresAt: DateTime.Utc;
    }) => Effect.Effect<void, PersonalGroupRepositoryError>;
  }
>()("t3/personal/groups/PersonalGroupRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlError = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation: `PersonalGroupRepository.${operation}`, cause });

  const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
    PersistenceDecodeError.fromSchemaError(`PersonalGroupRepository.${operation}`, cause);

  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) => effect.pipe(Effect.mapError(sqlError(operation)));

  const decodeAll =
    <A>(decode: (row: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
    (operation: string, rows: ReadonlyArray<unknown>) =>
      Effect.forEach(rows, (row) => decode(row).pipe(Effect.mapError(decodeError(operation))));

  const decodeGroups = decodeAll(decodeGroupRow);
  const decodeMembers = decodeAll(decodeMemberRow);
  const decodeRounds = decodeAll(decodeRoundRow);
  const decodeMessages = decodeAll(decodeMessageRow);

  const firstOf = <A>(decoded: ReadonlyArray<A>) => Option.fromNullishOr(decoded[0]);

  const transaction: PersonalGroupRepository["Service"]["transaction"] = (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) => (isSqlError(error) ? sqlError("transaction")(error) : error)),
      );

  const insertGroup: PersonalGroupRepository["Service"]["insertGroup"] = (group) =>
    query(
      "insertGroup",
      sql`
        INSERT INTO personal_groups (
          group_id, name, description, thread_id, max_bot_turns,
          created_at, updated_at, archived_at, deleted_at
        )
        VALUES (
          ${group.groupId}, ${group.name}, ${group.description}, ${group.threadId},
          ${group.maxBotTurns}, ${iso(group.createdAt)}, ${iso(group.updatedAt)},
          ${isoOrNull(group.archivedAt)}, NULL
        )
        ON CONFLICT(group_id) DO NOTHING
        RETURNING group_id AS "groupId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const getGroup: PersonalGroupRepository["Service"]["getGroup"] = (groupId) =>
    query(
      "getGroup",
      sql`
        SELECT ${sql.literal(GROUP_COLUMNS)} FROM personal_groups
        WHERE group_id = ${groupId} AND deleted_at IS NULL
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeGroups("getGroup", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const getGroupByThreadId: PersonalGroupRepository["Service"]["getGroupByThreadId"] = (threadId) =>
    query(
      "getGroupByThreadId",
      sql`
        SELECT ${sql.literal(GROUP_COLUMNS)} FROM personal_groups
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeGroups("getGroupByThreadId", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const listGroups: PersonalGroupRepository["Service"]["listGroups"] = () =>
    query(
      "listGroups",
      sql`
        SELECT ${sql.literal(GROUP_COLUMNS)} FROM personal_groups
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC, rowid DESC
      `,
    ).pipe(Effect.flatMap((rows) => decodeGroups("listGroups", rows)));

  const writeGroup: PersonalGroupRepository["Service"]["writeGroup"] = (group) =>
    query(
      "writeGroup",
      sql`
        UPDATE personal_groups
        SET name = ${group.name},
            description = ${group.description},
            archived_at = ${isoOrNull(group.archivedAt)},
            updated_at = ${iso(group.updatedAt)}
        WHERE group_id = ${group.groupId} AND deleted_at IS NULL
      `,
    ).pipe(Effect.asVoid);

  const softDeleteGroup: PersonalGroupRepository["Service"]["softDeleteGroup"] = (input) =>
    query(
      "softDeleteGroup",
      sql`
        UPDATE personal_groups
        SET deleted_at = ${iso(input.deletedAt)}, updated_at = ${iso(input.deletedAt)}
        WHERE group_id = ${input.groupId}
      `,
    ).pipe(Effect.asVoid);

  const insertMember: PersonalGroupRepository["Service"]["insertMember"] = (member) =>
    query(
      "insertMember",
      sql`
        INSERT INTO personal_group_members (
          group_id, bot_id, thread_id, role, sort_order, delivered_seq, joined_at, left_at
        )
        VALUES (
          ${member.groupId}, ${member.botId}, ${member.threadId}, ${member.role},
          ${member.sortOrder}, ${member.deliveredSeq}, ${iso(member.joinedAt)},
          ${isoOrNull(member.leftAt)}
        )
        ON CONFLICT(group_id, bot_id) DO NOTHING
        RETURNING bot_id AS "botId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const listMembers: PersonalGroupRepository["Service"]["listMembers"] = (groupId) =>
    query(
      "listMembers",
      sql`
        SELECT ${sql.literal(MEMBER_COLUMNS)} FROM personal_group_members
        WHERE group_id = ${groupId} AND left_at IS NULL
        ORDER BY sort_order ASC, bot_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeMembers("listMembers", rows)));

  const writeMember: PersonalGroupRepository["Service"]["writeMember"] = (member) =>
    query(
      "writeMember",
      sql`
        UPDATE personal_group_members
        SET thread_id = ${member.threadId},
            role = ${member.role},
            sort_order = ${member.sortOrder},
            delivered_seq = ${member.deliveredSeq},
            left_at = ${isoOrNull(member.leftAt)}
        WHERE group_id = ${member.groupId} AND bot_id = ${member.botId}
      `,
    ).pipe(Effect.asVoid);

  const removeMember: PersonalGroupRepository["Service"]["removeMember"] = (input) =>
    query(
      "removeMember",
      sql`
        DELETE FROM personal_group_members
        WHERE group_id = ${input.groupId} AND bot_id = ${input.botId}
      `,
    ).pipe(Effect.asVoid);

  const listMembershipsByBot: PersonalGroupRepository["Service"]["listMembershipsByBot"] = (
    botId,
  ) =>
    query(
      "listMembershipsByBot",
      sql`
        SELECT ${sql.literal(MEMBER_COLUMNS)} FROM personal_group_members
        WHERE bot_id = ${botId}
        ORDER BY group_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeMembers("listMembershipsByBot", rows)));

  const getMemberByThreadId: PersonalGroupRepository["Service"]["getMemberByThreadId"] = (
    threadId,
  ) =>
    query(
      "getMemberByThreadId",
      sql`
        SELECT ${sql.literal(MEMBER_COLUMNS)} FROM personal_group_members
        WHERE thread_id = ${threadId}
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeMembers("getMemberByThreadId", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const insertMessage: PersonalGroupRepository["Service"]["insertMessage"] = (input) =>
    query<{ readonly seq: number }>(
      "insertMessage",
      sql`
        INSERT INTO personal_group_messages (
          group_id, message_id, speaker_kind, speaker_bot_id, round_id, created_at
        )
        VALUES (
          ${input.groupId}, ${input.messageId}, ${input.speakerKind}, ${input.speakerBotId},
          ${input.roundId}, ${iso(input.createdAt)}
        )
        ON CONFLICT(message_id) DO NOTHING
        RETURNING seq AS "seq"
      `,
    ).pipe(
      Effect.flatMap((rows) => {
        const seq = rows[0]?.seq;
        if (seq !== undefined) {
          return Effect.succeed({ ...input, seq: Number(seq) });
        }
        // A concurrent insert (or a resend of the same client-minted id) won:
        // the existing row is the answer, so the caller stays idempotent.
        return getMessageByMessageId(input.messageId).pipe(
          Effect.map(Option.getOrElse(() => ({ ...input, seq: 0 }) as PersonalGroupMessageRecord)),
        );
      }),
    );

  const getMessageByMessageId: PersonalGroupRepository["Service"]["getMessageByMessageId"] = (
    messageId,
  ) =>
    query(
      "getMessageByMessageId",
      sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM personal_group_messages
        WHERE message_id = ${messageId}
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeMessages("getMessageByMessageId", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const listMessagesAfter: PersonalGroupRepository["Service"]["listMessagesAfter"] = (input) =>
    query(
      "listMessagesAfter",
      sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM personal_group_messages
        WHERE group_id = ${input.groupId} AND seq > ${input.afterSeq}
        ORDER BY seq ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeMessages("listMessagesAfter", rows)));

  const latestSeq: PersonalGroupRepository["Service"]["latestSeq"] = (groupId) =>
    query<{ readonly seq: number | null }>(
      "latestSeq",
      sql`SELECT MAX(seq) AS "seq" FROM personal_group_messages WHERE group_id = ${groupId}`,
    ).pipe(Effect.map((rows) => Number(rows[0]?.seq ?? 0)));

  const deleteMessage: PersonalGroupRepository["Service"]["deleteMessage"] = (messageId) =>
    query(
      "deleteMessage",
      sql`DELETE FROM personal_group_messages WHERE message_id = ${messageId}`,
    ).pipe(Effect.asVoid);

  const insertRound: PersonalGroupRepository["Service"]["insertRound"] = (round) =>
    query(
      "insertRound",
      sql`
        INSERT INTO personal_group_rounds (
          round_id, group_id, trigger_message_id, status, budget_remaining, queue_json,
          spoken_json, active_bot_id, active_thread_id, active_turn_id, active_message_id,
          relayed_chars, lease_owner, lease_expires_at, available_at, deadline_at,
          error_message, created_at, updated_at
        )
        VALUES (
          ${round.roundId}, ${round.groupId}, ${round.triggerMessageId}, ${round.status},
          ${round.budgetRemaining}, ${JSON.stringify(round.queue)},
          ${JSON.stringify(round.spoken)}, ${round.activeBotId}, ${round.activeThreadId},
          ${round.activeTurnId}, ${round.activeMessageId}, ${round.relayedChars},
          ${round.leaseOwner}, ${isoOrNull(round.leaseExpiresAt)},
          ${isoOrNull(round.availableAt)}, ${iso(round.deadlineAt)}, ${round.errorMessage},
          ${iso(round.createdAt)}, ${iso(round.updatedAt)}
        )
        ON CONFLICT(round_id) DO NOTHING
      `,
    ).pipe(Effect.asVoid);

  const getRound: PersonalGroupRepository["Service"]["getRound"] = (roundId) =>
    query(
      "getRound",
      sql`
        SELECT ${sql.literal(ROUND_COLUMNS)} FROM personal_group_rounds
        WHERE round_id = ${roundId}
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeRounds("getRound", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const writeRound: PersonalGroupRepository["Service"]["writeRound"] = (round) =>
    query(
      "writeRound",
      sql`
        UPDATE personal_group_rounds
        SET status = ${round.status},
            budget_remaining = ${round.budgetRemaining},
            queue_json = ${JSON.stringify(round.queue)},
            spoken_json = ${JSON.stringify(round.spoken)},
            active_bot_id = ${round.activeBotId},
            active_thread_id = ${round.activeThreadId},
            active_turn_id = ${round.activeTurnId},
            active_message_id = ${round.activeMessageId},
            relayed_chars = ${round.relayedChars},
            lease_owner = ${round.leaseOwner},
            lease_expires_at = ${isoOrNull(round.leaseExpiresAt)},
            available_at = ${isoOrNull(round.availableAt)},
            deadline_at = ${iso(round.deadlineAt)},
            error_message = ${round.errorMessage},
            updated_at = ${iso(round.updatedAt)}
        WHERE round_id = ${round.roundId}
      `,
    ).pipe(Effect.asVoid);

  const latestRoundForGroup: PersonalGroupRepository["Service"]["latestRoundForGroup"] = (
    groupId,
  ) =>
    query(
      "latestRoundForGroup",
      sql`
        SELECT ${sql.literal(ROUND_COLUMNS)} FROM personal_group_rounds
        WHERE group_id = ${groupId}
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeRounds("latestRoundForGroup", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const listLiveRounds: PersonalGroupRepository["Service"]["listLiveRounds"] = () =>
    query(
      "listLiveRounds",
      sql`
        SELECT ${sql.literal(ROUND_COLUMNS)} FROM personal_group_rounds
        WHERE ${sql.in("status", PERSONAL_GROUP_LIVE_ROUND_STATUSES)}
        ORDER BY created_at ASC, rowid ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeRounds("listLiveRounds", rows)));

  const getRoundByActiveThread: PersonalGroupRepository["Service"]["getRoundByActiveThread"] = (
    threadId,
  ) =>
    query(
      "getRoundByActiveThread",
      sql`
        SELECT ${sql.literal(ROUND_COLUMNS)} FROM personal_group_rounds
        WHERE active_thread_id = ${threadId}
          AND ${sql.in("status", PERSONAL_GROUP_LIVE_ROUND_STATUSES)}
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeRounds("getRoundByActiveThread", rows.slice(0, 1))),
      Effect.map(firstOf),
    );

  const heartbeat: PersonalGroupRepository["Service"]["heartbeat"] = (input) =>
    query(
      "heartbeat",
      sql`
        UPDATE personal_group_rounds
        SET lease_expires_at = ${iso(input.leaseExpiresAt)},
            updated_at = ${iso(input.now)}
        WHERE lease_owner = ${input.leaseOwner}
          AND ${sql.in("status", PERSONAL_GROUP_LIVE_ROUND_STATUSES)}
      `,
    ).pipe(Effect.asVoid);

  return {
    transaction,
    insertGroup,
    getGroup,
    getGroupByThreadId,
    listGroups,
    writeGroup,
    softDeleteGroup,
    insertMember,
    listMembers,
    writeMember,
    removeMember,
    listMembershipsByBot,
    getMemberByThreadId,
    insertMessage,
    getMessageByMessageId,
    listMessagesAfter,
    latestSeq,
    deleteMessage,
    insertRound,
    getRound,
    writeRound,
    latestRoundForGroup,
    listLiveRounds,
    getRoundByActiveThread,
    heartbeat,
  } satisfies PersonalGroupRepository["Service"];
});

export const layer = Layer.effect(PersonalGroupRepository, make);
