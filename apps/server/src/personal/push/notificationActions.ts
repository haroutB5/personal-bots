import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  CommandId,
  hidesBotPreviews,
  MessageId,
  PersonalBotId,
  PersonalPushError,
  RuntimeRequestId,
  ThreadId,
  type PersonalNotificationAnswerInput,
  type PersonalNotificationContent,
  type PersonalNotificationReplyInput,
  type PhonePushKind,
} from "@t3tools/contracts";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PersonalEngine from "../engine/PersonalEngine.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { makeFcmTokenStore, type PhoneNotificationRow } from "./fcmTokens.ts";
import {
  answersForChoice,
  inlineVerdict,
  isInlineRefusal,
  isRetryableRefusal,
  kindRefusal,
  type InlineRefusal,
  type PendingQuestion,
} from "./safeAnswer.ts";

/**
 * What a phone action came to. A value, not an error, so a stale tap and a
 * refusal are answers the route can store and replay; only a broken server
 * fails the effect.
 */
export type ActionOutcome =
  | { readonly _tag: "Done" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Stale" }
  | { readonly _tag: "InProgress" }
  | { readonly _tag: "Refused"; readonly reason: InlineRefusal };

export const outcomeStatus = (outcome: ActionOutcome): number => {
  switch (outcome._tag) {
    case "Done":
      return 200;
    case "NotFound":
      return 404;
    case "Stale":
    case "InProgress":
      return 409;
    case "Refused":
      return 422;
  }
};

const REFUSED_PREFIX = "Refused:";

export const encodeOutcome = (outcome: ActionOutcome): string =>
  outcome._tag === "Refused" ? `${REFUSED_PREFIX}${outcome.reason}` : outcome._tag;

export const decodeOutcome = (stored: string): ActionOutcome => {
  if (stored === "Done" || stored === "NotFound" || stored === "Stale" || stored === "InProgress") {
    return { _tag: stored };
  }
  if (stored.startsWith(REFUSED_PREFIX)) {
    const reason = stored.slice(REFUSED_PREFIX.length);
    if (isInlineRefusal(reason)) return { _tag: "Refused", reason };
  }
  return { _tag: "Stale" };
};

const refused = (reason: InlineRefusal): ActionOutcome => ({ _tag: "Refused", reason });

/** A reply is a chat message, so only the requests that need the app itself refuse it. */
const replyRefusal = (kind: PhonePushKind): InlineRefusal | null => {
  const byKind = kindRefusal(kind);
  return byKind === "approval-request" ||
    byKind === "sign-in-request" ||
    byKind === "secret-request"
    ? byKind
    : null;
};

type PendingQuestionState =
  | { readonly _tag: "Pending"; readonly questions: ReadonlyArray<PendingQuestion> }
  | { readonly _tag: "Gone" };

const GONE: PendingQuestionState = { _tag: "Gone" };

const questionView = (
  row: PhoneNotificationRow,
  pending: PendingQuestionState,
): PersonalNotificationContent["question"] => {
  const first = pending._tag === "Pending" ? pending.questions[0] : undefined;
  if (pending._tag !== "Pending" || first === undefined || row.requestId === null) return null;
  const verdict = inlineVerdict(row.kind, pending.questions);
  return {
    requestId: row.requestId,
    question: first.question,
    inlineOptions: verdict._tag === "Inline" ? [...verdict.labels] : null,
  };
};

export class NotificationActions extends Context.Service<
  NotificationActions,
  {
    readonly content: (input: {
      readonly sessionId: string;
      readonly notificationId: string;
    }) => Effect.Effect<Option.Option<PersonalNotificationContent>, PersonalPushError>;
    readonly reply: (
      input: PersonalNotificationReplyInput & {
        readonly sessionId: string;
        readonly notificationId: string;
      },
    ) => Effect.Effect<ActionOutcome, PersonalPushError>;
    readonly answer: (
      input: PersonalNotificationAnswerInput & {
        readonly sessionId: string;
        readonly notificationId: string;
      },
    ) => Effect.Effect<ActionOutcome, PersonalPushError>;
  }
>()("t3/personal/push/NotificationActions") {}

const storageFailure = (what: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new PersonalPushError({ message: `Phone notification ${what} failed.`, cause }),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const engine = yield* PersonalEngine.PersonalEngine;
  const store = makeFcmTokenStore(sql);

  const ownNotification = (sessionId: string, notificationId: string) =>
    Effect.gen(function* () {
      const subject = yield* store.subjectOfSession(sessionId);
      if (Option.isNone(subject)) return Option.none();
      const row = yield* store.findNotification(notificationId, subject.value);
      return Option.map(row, (found) => ({ subject: subject.value, row: found }));
    });

  const pendingQuestion = (row: PhoneNotificationRow): Effect.Effect<PendingQuestionState> =>
    row.kind !== "question" || row.requestId === null
      ? Effect.succeed(GONE)
      : threads
          .getThreadRecords(ThreadId.make(row.threadId), ["runtimeRequests", "turnItems"], {
            turnItemTypes: ["user_input_request"],
          })
          .pipe(
            Effect.map((records): PendingQuestionState => {
              const request = records.runtimeRequests.find(
                (candidate) => candidate.id === row.requestId && candidate.kind === "user_input",
              );
              const item = records.turnItems.find(
                (candidate) =>
                  candidate.type === "user_input_request" && candidate.requestId === row.requestId,
              );
              if (
                request === undefined ||
                request.status !== "pending" ||
                item === undefined ||
                item.type !== "user_input_request" ||
                item.responseMode === "message"
              ) {
                return GONE;
              }
              return { _tag: "Pending", questions: item.questions };
            }),
            Effect.orElseSucceed(() => GONE),
          );

  const hidesPreviews = (botId: string) =>
    bots.getBotById({ botId: PersonalBotId.make(botId) }).pipe(
      Effect.map((bot) => Option.isSome(bot) && hidesBotPreviews(bot.value)),
      Effect.orElseSucceed(() => true),
    );

  const content: NotificationActions["Service"]["content"] = (input) =>
    Effect.gen(function* () {
      const found = yield* ownNotification(input.sessionId, input.notificationId);
      if (Option.isNone(found)) return Option.none<PersonalNotificationContent>();
      const { row } = found.value;
      const hidden = yield* hidesPreviews(row.botId);
      const pending = hidden ? GONE : yield* pendingQuestion(row);
      return Option.some<PersonalNotificationContent>({
        notificationId: row.notificationId,
        kind: row.kind,
        botId: row.botId,
        threadId: row.threadId,
        text: hidden ? null : row.body,
        question: questionView(row, pending),
      });
    }).pipe(storageFailure("lookup"));

  /**
   * Runs an action once per (command id, subject). The first call claims the
   * row and stores what it came to; a repeat gets that stored answer and has
   * no effect. A claim whose action failed, or that ended in a retryable
   * refusal, is released so the same id can try again. A claim left unfinished
   * by a crash stays: that id answers "in progress" and never re-runs, so a
   * tap never takes effect twice.
   */
  const once = (input: {
    readonly subject: string;
    readonly commandId: string;
    readonly notificationId: string;
    readonly action: "reply" | "answer";
    readonly run: Effect.Effect<ActionOutcome, unknown>;
  }) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* sql<{ readonly commandId: string }>`
        INSERT INTO personal_phone_commands (
          command_id, subject, action, notification_id, status, body, created_at
        )
        VALUES (
          ${input.commandId}, ${input.subject}, ${input.action}, ${input.notificationId},
          NULL, NULL, ${nowIso}
        )
        ON CONFLICT (command_id, subject) DO NOTHING
        RETURNING command_id AS "commandId"
      `;
      if (claimed.length === 0) {
        const first = yield* sql<{ readonly body: string | null; readonly action: string }>`
          SELECT body AS "body", action AS "action" FROM personal_phone_commands
          WHERE command_id = ${input.commandId} AND subject = ${input.subject}
          LIMIT 1
        `;
        const stored = first[0];
        if (stored === undefined || stored.action !== input.action || stored.body === null) {
          return { _tag: "InProgress" } as const satisfies ActionOutcome;
        }
        return decodeOutcome(stored.body);
      }
      const release = sql`
        DELETE FROM personal_phone_commands
        WHERE command_id = ${input.commandId} AND subject = ${input.subject}
      `;
      const outcome = yield* input.run.pipe(Effect.onError(() => release.pipe(Effect.ignore)));
      if (outcome._tag === "Refused" && isRetryableRefusal(outcome.reason)) {
        yield* release;
        return outcome;
      }
      yield* sql`
        UPDATE personal_phone_commands
        SET status = ${outcomeStatus(outcome)}, body = ${encodeOutcome(outcome)}
        WHERE command_id = ${input.commandId} AND subject = ${input.subject}
      `;
      return outcome;
    });

  const reply: NotificationActions["Service"]["reply"] = (input) =>
    Effect.gen(function* () {
      const found = yield* ownNotification(input.sessionId, input.notificationId);
      if (Option.isNone(found)) return { _tag: "NotFound" } as const satisfies ActionOutcome;
      const { subject, row } = found.value;
      return yield* once({
        subject,
        commandId: input.commandId,
        notificationId: row.notificationId,
        action: "reply",
        run: Effect.gen(function* () {
          const byKind = replyRefusal(row.kind);
          if (byKind !== null) return refused(byKind);
          if (row.threadId.length === 0) return refused("not-a-question");
          yield* engine.send({
            threadId: ThreadId.make(row.threadId),
            messageId: MessageId.make(`phone-reply:${input.commandId}`),
            text: input.text,
            attachments: [],
            mode: "queue",
          });
          return { _tag: "Done" } as const satisfies ActionOutcome;
        }),
      });
    }).pipe(storageFailure("reply"));

  const answer: NotificationActions["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      const found = yield* ownNotification(input.sessionId, input.notificationId);
      if (Option.isNone(found)) return { _tag: "NotFound" } as const satisfies ActionOutcome;
      const { subject, row } = found.value;
      return yield* once({
        subject,
        commandId: input.commandId,
        notificationId: row.notificationId,
        action: "answer",
        run: Effect.gen(function* () {
          const byKind = kindRefusal(row.kind);
          if (byKind !== null) return refused(byKind);
          if (yield* hidesPreviews(row.botId)) return refused("previews-hidden");
          if (row.requestId === null) return { _tag: "Stale" } as const satisfies ActionOutcome;
          const pending = yield* pendingQuestion(row);
          if (pending._tag === "Gone") return { _tag: "Stale" } as const satisfies ActionOutcome;
          const verdict = inlineVerdict(row.kind, pending.questions);
          if (verdict._tag === "Refused") return refused(verdict.reason);
          const answers = answersForChoice(pending.questions, input.choice);
          if (answers === null) return refused("unknown-choice");
          yield* threads.dispatch({
            type: "runtime-request.respond",
            threadId: ThreadId.make(row.threadId),
            commandId: CommandId.make(`phone-answer:${input.commandId}`),
            requestId: RuntimeRequestId.make(row.requestId),
            answers,
          });
          return { _tag: "Done" } as const satisfies ActionOutcome;
        }),
      });
    }).pipe(storageFailure("answer"));

  return NotificationActions.of({ content, reply, answer });
});

export const layer = Layer.effect(NotificationActions, make);
