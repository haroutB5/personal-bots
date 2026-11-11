import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { PhonePushKind } from "@t3tools/contracts";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PersonalEngine from "../engine/PersonalEngine.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import { makeFcmTokenStore } from "./fcmTokens.ts";
import * as NotificationActions from "./notificationActions.ts";
import {
  decodeOutcome,
  encodeOutcome,
  outcomeStatus,
  type ActionOutcome,
} from "./notificationActions.ts";
import { INLINE_REFUSALS } from "./safeAnswer.ts";

const THREAD = "thread-1";
const BOT = "bot-1";

interface Option_ {
  readonly label: string;
  readonly description: string;
  readonly value?: string;
}

interface Question {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect?: boolean;
  readonly options: ReadonlyArray<Option_>;
}

const table: Question = {
  id: "q1",
  header: "Dinner",
  question: "Which table should I book?",
  options: [
    { label: "Window", description: "By the glass", value: "table-window" },
    { label: "Bar", description: "Quick" },
  ],
};

interface Harness {
  requestStatus: "pending" | "resolved";
  questions: ReadonlyArray<Question>;
  responseMode: "message" | undefined;
  hidePreviews: boolean;
  failSendOnce: boolean;
  readonly dispatched: Array<Record<string, unknown>>;
  readonly sent: Array<Record<string, unknown>>;
}

const newHarness = (patch: Partial<Harness> = {}): Harness => ({
  requestStatus: "pending",
  questions: [table],
  responseMode: undefined,
  hidePreviews: false,
  failSendOnce: false,
  dispatched: [],
  sent: [],
  ...patch,
});

const layerFor = (harness: Harness) =>
  NotificationActions.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadRecords: () =>
          Effect.succeed({
            runtimeRequests: [{ id: "req-1", kind: "user_input", status: harness.requestStatus }],
            turnItems: [
              {
                type: "user_input_request",
                requestId: "req-1",
                questions: harness.questions,
                ...(harness.responseMode === undefined
                  ? {}
                  : { responseMode: harness.responseMode }),
              },
            ],
          }),
        dispatch: (command: Record<string, unknown>) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            harness.requestStatus = "resolved";
            return { sequence: harness.dispatched.length };
          }),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(PersonalEngine.PersonalEngine, {
        send: (input: Record<string, unknown>) =>
          harness.failSendOnce
            ? Effect.sync(() => {
                harness.failSendOnce = false;
              }).pipe(Effect.andThen(Effect.fail(new Error("send failed")) as never))
            : Effect.sync(() => {
                harness.sent.push(input);
              }),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(PersonalBotRepository.PersonalBotRepository, {
        getBotById: () =>
          Effect.succeed(
            harness.hidePreviews ? Option.some({ hidePreviews: true }) : Option.none(),
          ),
      } as never),
    ),
    Layer.provideMerge(personalTestDatabase),
  );

const seedSession = (sessionId: string, subject: string, revoked = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
      VALUES (${sessionId}, ${subject}, '[]', 'bearer-session-token',
              '2026-09-18T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
              ${revoked ? "2026-09-18T08:00:00.000Z" : null})
    `;
  });

const seedNotification = (
  notificationId: string,
  kind: PhonePushKind,
  subject = "owner",
  body: string | null = "Which table should I book?",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* makeFcmTokenStore(sql).recordNotification(
      { notificationId, kind, botId: BOT, threadId: THREAD, requestId: "req-1", body },
      [subject],
    );
  });

const setup = Effect.gen(function* () {
  yield* seedSession("session-owner", "owner");
  yield* seedSession("session-other", "someone-else");
  yield* seedNotification("chat-needs:req-1", "question");
  return yield* NotificationActions.NotificationActions;
});

const commandRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly commandId: string; readonly status: number | null }>`
    SELECT command_id AS "commandId", status AS "status" FROM personal_phone_commands
  `;
});

const pick = (id: string) => ({ sessionId: "session-owner", notificationId: id });

it.effect("content gives the owner the text and the labels a tap may answer with", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const content = yield* actions.content(pick("chat-needs:req-1"));
    expect(Option.getOrNull(content)).toEqual({
      notificationId: "chat-needs:req-1",
      kind: "question",
      botId: BOT,
      threadId: THREAD,
      text: "Which table should I book?",
      question: {
        requestId: "req-1",
        question: "Which table should I book?",
        inlineOptions: ["Window", "Bar"],
      },
    });
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("content says the app must open when the question is not safe to tap", () => {
  const harness = newHarness({
    questions: [{ ...table, options: [{ label: "Delete it", description: "Gone for good" }] }],
  });
  return Effect.gen(function* () {
    const actions = yield* setup;
    const content = Option.getOrThrow(yield* actions.content(pick("chat-needs:req-1")));
    expect(content.question?.inlineOptions).toBeNull();
    expect(content.question?.question).toBe("Which table should I book?");
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("content has no question once the request is answered", () => {
  const harness = newHarness({ requestStatus: "resolved" });
  return Effect.gen(function* () {
    const actions = yield* setup;
    const content = Option.getOrThrow(yield* actions.content(pick("chat-needs:req-1")));
    expect(content.question).toBeNull();
    expect(content.text).toBe("Which table should I book?");
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("content hides the text and the question while the bot hides previews", () => {
  const harness = newHarness({ hidePreviews: true });
  return Effect.gen(function* () {
    const actions = yield* setup;
    const content = Option.getOrThrow(yield* actions.content(pick("chat-needs:req-1")));
    expect(content.text).toBeNull();
    expect(content.question).toBeNull();
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("content, reply and answer treat another user's notification as not found", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const stranger = { sessionId: "session-other", notificationId: "chat-needs:req-1" };
    expect(Option.isNone(yield* actions.content(stranger))).toBe(true);
    expect(yield* actions.answer({ ...stranger, commandId: "c1", choice: "Window" })).toEqual({
      _tag: "NotFound",
    });
    expect(yield* actions.reply({ ...stranger, commandId: "c2", text: "hi" })).toEqual({
      _tag: "NotFound",
    });
    expect(harness.dispatched).toEqual([]);
    expect(harness.sent).toEqual([]);
    expect(yield* commandRows).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a revoked session and an unknown id are not found", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    yield* seedSession("session-revoked", "owner", true);
    expect(
      Option.isNone(
        yield* actions.content({
          sessionId: "session-revoked",
          notificationId: "chat-needs:req-1",
        }),
      ),
    ).toBe(true);
    expect(Option.isNone(yield* actions.content(pick("chat-needs:nothing")))).toBe(true);
    expect(
      yield* actions.answer({ ...pick("chat-needs:nothing"), commandId: "c1", choice: "Window" }),
    ).toEqual({ _tag: "NotFound" });
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("answer responds to the request with the chosen option's value, once", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const first = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "cmd-1",
      choice: "Window",
    });
    expect(first).toEqual({ _tag: "Done" });
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]).toMatchObject({
      type: "runtime-request.respond",
      threadId: THREAD,
      requestId: "req-1",
      answers: { q1: "table-window" },
    });
    expect(yield* commandRows).toEqual([{ commandId: "cmd-1", status: 200 }]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a repeated command id returns the first result and has no second effect", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const input = { ...pick("chat-needs:req-1"), commandId: "cmd-1", choice: "Window" };
    const first = yield* actions.answer(input);
    const again = yield* actions.answer(input);
    const withOtherChoice = yield* actions.answer({ ...input, choice: "Bar" });
    expect(first).toEqual({ _tag: "Done" });
    expect(again).toEqual(first);
    expect(withOtherChoice).toEqual(first);
    expect(harness.dispatched).toHaveLength(1);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a stale tap answers stale and does not respond", () => {
  const harness = newHarness({ requestStatus: "resolved" });
  return Effect.gen(function* () {
    const actions = yield* setup;
    const result = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "cmd-1",
      choice: "Window",
    });
    expect(result).toEqual({ _tag: "Stale" });
    expect(outcomeStatus(result)).toBe(409);
    expect(harness.dispatched).toEqual([]);
    const replay = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "cmd-1",
      choice: "Window",
    });
    expect(replay).toEqual({ _tag: "Stale" });
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a choice the notification did not offer is stale and does not respond", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const result = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "cmd-1",
      choice: "Patio",
    });
    expect(result).toEqual({ _tag: "Stale" });
    expect(harness.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("answer refuses each request kind that needs the app, and never responds", () => {
  const harness = newHarness();
  const expected: ReadonlyArray<readonly [PhonePushKind, string]> = [
    ["approval", "approval-request"],
    ["sign-in", "sign-in-request"],
    ["secret", "secret-request"],
    ["chat-reply", "not-a-question"],
    ["failure", "not-a-question"],
    ["task", "not-a-question"],
  ];
  return Effect.gen(function* () {
    const actions = yield* setup;
    for (const [kind, reason] of expected) {
      yield* seedNotification(`n-${kind}`, kind);
      const result = yield* actions.answer({
        ...pick(`n-${kind}`),
        commandId: `cmd-${kind}`,
        choice: "Window",
      });
      expect(result).toEqual({ _tag: "Refused", reason });
      expect(outcomeStatus(result)).toBe(422);
    }
    expect(harness.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("answer refuses a destructive question the phone should not tap", () => {
  const harness = newHarness({
    questions: [{ ...table, options: [{ label: "Wipe it", description: "Clean slate" }] }],
  });
  return Effect.gen(function* () {
    const actions = yield* setup;
    expect(
      yield* actions.answer({ ...pick("chat-needs:req-1"), commandId: "c1", choice: "Wipe it" }),
    ).toEqual({ _tag: "Refused", reason: "destructive-word" });
    expect(harness.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("answer refuses a multi-select question", () => {
  const harness = newHarness({ questions: [{ ...table, multiSelect: true }] });
  return Effect.gen(function* () {
    const actions = yield* setup;
    expect(
      yield* actions.answer({ ...pick("chat-needs:req-1"), commandId: "c1", choice: "Window" }),
    ).toEqual({ _tag: "Refused", reason: "multi-select" });
    expect(harness.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a request answered in the chat message is not answered from the phone", () => {
  const harness = newHarness({ responseMode: "message" });
  return Effect.gen(function* () {
    const actions = yield* setup;
    const result = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "cmd-1",
      choice: "Window",
    });
    expect(result).toEqual({ _tag: "Stale" });
    expect(harness.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("reply queues one message for the chat, however often the same command arrives", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const input = { ...pick("chat-needs:req-1"), commandId: "cmd-r1", text: "Take the window." };
    expect(yield* actions.reply(input)).toEqual({ _tag: "Done" });
    expect(yield* actions.reply(input)).toEqual({ _tag: "Done" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      threadId: THREAD,
      text: "Take the window.",
      attachments: [],
      mode: "queue",
      messageId: "phone-reply:cmd-r1",
    });
    expect(yield* actions.reply({ ...input, commandId: "cmd-r2" })).toEqual({ _tag: "Done" });
    expect(harness.sent).toHaveLength(2);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("reply refuses a request that needs the app, and a notification with no chat", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    yield* seedNotification("n-approval", "approval");
    yield* seedNotification("n-secret", "secret");
    yield* seedNotification("n-reply", "chat-reply");
    expect(yield* actions.reply({ ...pick("n-approval"), commandId: "r1", text: "ok" })).toEqual({
      _tag: "Refused",
      reason: "approval-request",
    });
    expect(yield* actions.reply({ ...pick("n-secret"), commandId: "r2", text: "ok" })).toEqual({
      _tag: "Refused",
      reason: "secret-request",
    });
    expect(yield* actions.reply({ ...pick("n-reply"), commandId: "r3", text: "ok" })).toEqual({
      _tag: "Done",
    });
    expect(harness.sent).toHaveLength(1);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a failed send releases the command id so the retry can succeed", () => {
  const harness = newHarness({ failSendOnce: true });
  return Effect.gen(function* () {
    const actions = yield* setup;
    const input = { ...pick("chat-needs:req-1"), commandId: "cmd-r1", text: "Take the window." };
    const failure = yield* actions.reply(input).pipe(Effect.flip);
    expect(failure.message).toBe("Phone notification reply failed.");
    expect(yield* commandRows).toEqual([]);
    expect(yield* actions.reply(input)).toEqual({ _tag: "Done" });
    expect(harness.sent).toHaveLength(1);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("a command id left unfinished by a crash answers in progress and never re-runs", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_phone_commands (
        command_id, subject, action, notification_id, status, body, created_at
      )
      VALUES ('cmd-1', 'owner', 'answer', 'chat-needs:req-1', NULL, NULL, '2026-09-18T09:00:00.000Z')
    `;
    const result = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "cmd-1",
      choice: "Window",
    });
    expect(result).toEqual({ _tag: "InProgress" });
    expect(harness.dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(harness)));
});

it.effect("the same command id from another user is its own command", () => {
  const harness = newHarness();
  return Effect.gen(function* () {
    const actions = yield* setup;
    yield* seedNotification("chat-needs:req-1", "question", "someone-else");
    const mine = yield* actions.answer({
      ...pick("chat-needs:req-1"),
      commandId: "shared-id",
      choice: "Window",
    });
    expect(mine).toEqual({ _tag: "Done" });
    const theirs = yield* actions.reply({
      sessionId: "session-other",
      notificationId: "chat-needs:req-1",
      commandId: "shared-id",
      text: "hello",
    });
    expect(theirs).toEqual({ _tag: "Done" });
    expect(harness.sent).toHaveLength(1);
  }).pipe(Effect.provide(layerFor(harness)));
});

const outcomes: ReadonlyArray<ActionOutcome> = [
  { _tag: "Done" },
  { _tag: "NotFound" },
  { _tag: "Stale" },
  { _tag: "InProgress" },
  ...INLINE_REFUSALS.map((reason) => ({ _tag: "Refused", reason }) as const),
];

it("a stored outcome decodes to what was stored, and the status follows the outcome", () => {
  for (const outcome of outcomes) {
    expect(decodeOutcome(encodeOutcome(outcome))).toEqual(outcome);
  }
  expect(decodeOutcome("Refused:not-a-reason")).toEqual({ _tag: "Stale" });
  expect(decodeOutcome("garbage")).toEqual({ _tag: "Stale" });
  expect(outcomes.map(outcomeStatus)).toEqual([
    200,
    404,
    409,
    409,
    ...INLINE_REFUSALS.map(() => 422),
  ]);
});
