// @effect-diagnostics preferSchemaOverJson:off - the fake transport returns the raw Gemini body, which is the point of the test.
/**
 * The call-summary worker, end to end except Google: the HTTP boundary is a
 * fake transport, so the test proves the exact request (URL, model, the broker
 * placeholder in the header, the transcript in the prompt) and the exact
 * behaviour of every path that matters, including every fix the Astra review
 * asked for:
 *
 * - the sensitive-chat gate, which the worker must pass exactly like a call
 *   (finding 1), with the relay query narrowed to this call's own messages;
 * - team-lead-only eligibility (finding 2);
 * - persisted, capped attempts that cannot starve older calls (finding 5);
 * - the fallback model tried when the primary's answer is unusable
 *   (finding 8);
 * - and no log line carrying the owner's words (finding 7).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import {
  PersonalBotId,
  ThreadId,
  VOICE_CALL_SECRET_HEADER,
  VOICE_CALL_SUMMARY_FALLBACK_MODEL,
  VOICE_CALL_SUMMARY_MAX_ATTEMPTS,
  VOICE_CALL_SUMMARY_MODEL,
  VOICE_CALL_SUMMARY_RETRY_MS,
  type VoiceCallSummary,
} from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import type { BrokerRequest, BrokerSecret, SecretBrokerError } from "../secrets/secretBroker.ts";
import * as PersonalTaskRepository from "../tasks/PersonalTaskRepository.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import {
  PersonalVoiceCallSummaryService,
  layer as summaryLayer,
} from "./PersonalVoiceCallSummaryService.ts";
import { VoiceCallHttp, type VoiceCallMintOutcome } from "./voiceCallGemini.ts";
import { VOICE_CALL_GREETING_SUMMARY, parseVoiceCallSummary } from "./voiceCallSummary.ts";
import { VoiceCallSummaryClaude } from "./voiceCallSummaryClaude.ts";

const CTO_CHAT = ThreadId.make("thread-call-summary");
const CTO_BOT = PersonalBotId.make("bot-cto");
const CALL_ID = "8f9c3ace-a17b-4086-aa8a-e53058b480a9";
const KEY_VALUE = "AIza-TEST-ONLY-KEY-VALUE";
/** What the Claude writer in these tests says it is (the real one resolves the same way). */
const CLAUDE_MODEL = "claude-haiku-5-5";
/** Text that must never reach a log line or a block the bot is given. */
const PRIVATE = "SECRET-OWNER-WORDS-7f3a91";

/** The real call's own lines, the ones the acceptance criteria name. */
const REAL_TRANSCRIPT = JSON.stringify([
  { speaker: "you", text: "pare 20 pesos", at: "2026-10-16T13:59:23.660Z" },
  {
    speaker: "you",
    text: "Can you check if there is a tennis booking?",
    at: "2026-10-16T14:00:13.213Z",
  },
  {
    speaker: "voice",
    text: "You have a confirmed booking for Court 2 on Saturday from 12:00 to 15:00.",
    at: "2026-10-16T14:00:13.215Z",
  },
  {
    speaker: "you",
    text: "Okay, but check court one or court three as well.",
    at: "2026-10-16T14:01:04.183Z",
  },
  {
    speaker: "voice",
    text: "Court three is free from eleven to twelve, but you would need to move to court two at twelve.",
    at: "2026-10-16T14:01:40.301Z",
  },
  {
    speaker: "you",
    text: "Okay, that's fine. Thank you. I just wanted to know.",
    at: "2026-10-16T14:01:49.948Z",
  },
]);

const GOOD_ANSWER = JSON.stringify({
  summary:
    "He asked whether a court was free before his Saturday booking; Court 3 is free 11:00-12:00.",
  points: [
    "Court 2 is booked Saturday 12:00-15:00",
    "Court 3 free 11:00-12:00 Saturday",
    "Playing 11:00-12:00 means moving to Court 2 at 12:00",
  ],
  decision: "No change, he just wanted to know",
  open: null,
});

/**
 * The real greeting-only call, both lines: 9a6e8901-f51f-4de0-925b-46196f37a985,
 * ten seconds, 16 Oct 2026, copied read-only out of the live table. It is the
 * call whose summary claimed "the CTO confirmed that all preparations are
 * complete" when all he had said was hello.
 */
const GREETING_TRANSCRIPT = JSON.stringify([
  { speaker: "you", text: "Hello, how are you?", at: "2026-10-16T21:05:54.742Z" },
  {
    speaker: "voice",
    text: "Hello, I'm doing well. Everything is ready for you.",
    at: "2026-10-16T21:05:54.749Z",
  },
]);

/**
 * What the real Claude writer answers for one decoded object: it is the same
 * parser the Gemini answers go through, so a stub that means "Claude returned
 * this JSON" is written once, here.
 */
const fromClaude = (answer: unknown): VoiceCallSummary | null =>
  parseVoiceCallSummary(JSON.stringify(answer));

interface HttpCall {
  readonly request: BrokerRequest;
  readonly secrets: ReadonlyArray<BrokerSecret>;
}
interface HarnessOptions {
  readonly calls: Array<HttpCall>;
  /** What the fake transport answers; the default is a good summary. */
  readonly answer?: (model: string) => VoiceCallMintOutcome;
  /**
   * The stubbed Claude writer. Left out, Claude is "unavailable" (a usage
   * limit, a missing CLI): every Gemini test below runs on that default, which
   * is exactly the fallback path the release has to keep working.
   */
  readonly claude?:
    | ((prompt: string) => Effect.Effect<VoiceCallSummary | null, string>)
    | undefined;
  /** Make the transport itself fail, as a broker refusal does. */
  readonly throws?: boolean;
  /** The saved key; `false` means no Gemini key at all. */
  readonly withKey?: boolean;
  /** The call's own transcript; `null` seeds a call with no transcript lines. */
  readonly transcriptJson?: string | null;
  /** The bot's team-lead flag (Harout, 16 Oct: only leads take calls). */
  readonly botIsLead?: boolean;
  /** Sensitive exposure rows written for the chat, as the browser would. */
  readonly exposed?: ReadonlyArray<string>;
  /** A task row whose ROOT key is tainted instead of the chat's own key. */
  readonly exposedRootTaskId?: string | null;
  /** The task association lookup itself fails (Astra re-check R1). */
  readonly taskLookupFails?: boolean;
  /** Runs while the key is read, i.e. between the first and second gate. */
  readonly onSecrets?: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>;
  /** Runs just before one model is asked, as a slow primary request would. */
  readonly onAnswer?: (
    model: string,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const good = (): VoiceCallMintOutcome => ({
  status: 200,
  token: null,
  body: JSON.stringify({ candidates: [{ content: { parts: [{ text: GOOD_ANSWER }] } }] }),
});

const unusable = (): VoiceCallMintOutcome => ({
  status: 200,
  token: null,
  body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "{not json" }] } }] }),
});

const down = (): VoiceCallMintOutcome => ({
  status: 500,
  token: null,
  body: '{"error":{"message":"down"}}',
});

const makeHarness = (options: HarnessOptions) => {
  const key: PersonalSessionAccess.PersonalSessionSecret = {
    name: "GEMINI_API_KEY",
    mode: "brokered",
    origins: ["https://generativelanguage.googleapis.com"],
    placement: { header: VOICE_CALL_SECRET_HEADER },
    value: KEY_VALUE,
  };
  const saved = options.withKey === false ? [] : [key];
  const taskLayer =
    options.taskLookupFails === true
      ? Layer.mock(PersonalTaskRepository.PersonalTaskRepository)({
          latestTaskForThread: () => Effect.die(new Error("task lookup failed")),
        })
      : PersonalTaskRepository.layer;
  return summaryLayer.pipe(
    Layer.provideMerge(PersonalVoiceCallRepository.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(taskLayer),
    // The Claude writer, stubbed. The real layer resolves the provider
    // instance registry and the CLI; here it is one function, which is what
    // lets the tests prove the Claude-first order and the fallback on its own.
    Layer.provideMerge(
      Layer.succeed(
        VoiceCallSummaryClaude,
        VoiceCallSummaryClaude.of({
          model: CLAUDE_MODEL,
          effort: "medium",
          ask: (prompt) =>
            options.claude?.(prompt) ??
            Effect.fail("the Claude CLI is at its usage limit or not installed"),
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(PersonalBotService.PersonalBotService)({
        getProfile: () =>
          Effect.succeed({
            displayName: "Harout",
            autoArchiveTaskChats: true,
            voiceCalls: {
              voiceName: "Charon",
              quietHangupMinutes: 2,
              languages: "English, French, Arabic and Armenian",
            },
          }),
      }),
    ),
    // `Layer.effect`, not `Layer.succeed`: these two stand-ins need the
    // database so a test can write a sensitive-exposure row while the worker is
    // between steps, which is exactly the window R1 is about. They are built on
    // the same SQL client as everything else, never a second one, which is why
    // the in-memory database is provided last: every layer above it can see it.
    Layer.provideMerge(
      Layer.effect(
        PersonalSessionAccess.PersonalSessionAccess,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            forThread: () =>
              Effect.succeed({ botId: null, environment: {}, systemInstructions: null }),
            secretsForThread: () =>
              Effect.gen(function* () {
                if (options.onSecrets !== undefined) {
                  yield* Effect.orDie(options.onSecrets(sql));
                }
                return saved;
              }),
            sharedSecrets: () => Effect.succeed(saved),
            instructionsForThread: () => Effect.succeed(null),
          } satisfies PersonalSessionAccess.PersonalSessionAccess["Service"];
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.effect(
        VoiceCallHttp,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            call: (request: BrokerRequest, secrets: ReadonlyArray<BrokerSecret>) =>
              Effect.gen(function* () {
                if (options.throws === true) {
                  return yield* Effect.fail({
                    _tag: "SecretBrokerError",
                    message: "no saved key named",
                  } as unknown as SecretBrokerError);
                }
                options.calls.push({ request, secrets });
                const model = /models\/([^:]+):/.exec(request.url)?.[1] ?? "";
                if (options.onAnswer !== undefined) {
                  yield* Effect.orDie(options.onAnswer(model, sql));
                }
                return options.answer?.(model) ?? good();
              }),
          } satisfies VoiceCallHttp["Service"];
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
};

/** The bot, one finished call card and whatever the case needs around it. */
const seed = (options: HarnessOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transcript =
      options.transcriptJson === undefined ? REAL_TRANSCRIPT : options.transcriptJson;
    const now = "2026-10-16T14:02:06.000Z";
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at,
        is_lead, allow_voice_calls
      )
      VALUES (
        ${CTO_BOT}, 'CTO', '', '', 'blob', '#1A73E8',
        '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0, ${now}, ${now},
        ${options.botIsLead === false ? 0 : 1}, 0
      )
    `;
    yield* sql`
      INSERT INTO personal_voice_calls (
        call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
        end_reason, message_count, voice_name, model, detail, transcript_json, created_at
      )
      VALUES (
        ${CALL_ID}, ${CTO_CHAT}, ${CTO_BOT}, '2026-10-16T13:59:17.443Z',
        '2026-10-16T14:02:05.126Z', 168, 'said_bye', 3, 'Charon', 'gemini-3.8-live', '',
        ${transcript ?? "[]"}, ${now}
      )
    `;
    for (const source of options.exposed ?? []) {
      yield* sql`
        INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
        VALUES (${`thread:${CTO_CHAT}`}, 'source', ${source}, ${now})
      `;
    }
    if (options.exposedRootTaskId != null) {
      // The chat belongs to a task tree whose ROOT carries the taint: the same
      // second key the browser writes and reads.
      yield* sql`
        INSERT INTO personal_tasks (
          task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective,
          acceptance_criteria, expected_output, status, source, idempotency_key,
          depth, max_depth, max_children, created_at, updated_at
        )
        VALUES (
          'task-summary', ${options.exposedRootTaskId}, NULL, ${CTO_BOT}, ${CTO_CHAT},
          'A task', 'Do it', '', '', 'running', 'delegation', 'task-summary', 0, 1, 5,
          ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
        VALUES (${`root:${options.exposedRootTaskId}`}, 'source', 'the bank', ${now})
      `;
    }
  });

const withService = <A, E, R>(
  options: HarnessOptions,
  body: (
    service: PersonalVoiceCallSummaryService["Service"],
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* seed(options);
    const service = yield* PersonalVoiceCallSummaryService;
    const sql = yield* SqlClient.SqlClient;
    return yield* body(service, sql);
  }).pipe(Effect.provide(makeHarness(options)));

const storedSummary = (sql: SqlClient.SqlClient) =>
  sql<{ readonly summary: string }>`
    SELECT summary_json AS "summary" FROM personal_voice_calls WHERE call_id = ${CALL_ID}
  `.pipe(Effect.map((rows) => rows[0]?.summary ?? ""));

const storedAttempts = (sql: SqlClient.SqlClient) =>
  sql<{ readonly attempts: number }>`
    SELECT summary_attempts AS "attempts" FROM personal_voice_calls WHERE call_id = ${CALL_ID}
  `.pipe(Effect.map((rows) => Number(rows[0]?.attempts ?? 0)));

describe("PersonalVoiceCallSummaryService.summarise", () => {
  it.effect("falls back to one Gemini text call when Claude cannot answer", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service, sql) =>
      Effect.gen(function* () {
        const summary = yield* service.summarise(CALL_ID);
        expect(summary).not.toBeNull();
        expect(summary!.summary).toContain("Court 3 is free 11:00-12:00");
        expect(summary!.points).toHaveLength(3);
        expect(summary!.decision).toBe("No change, he just wanted to know");
        // Which model wrote it, so the owner and a diagnosis can tell. The
        // Gemini path names no effort, so nothing is stored for it (the
        // medium-effort label belongs to the Claude summary request alone).
        expect(summary!.model).toBe(VOICE_CALL_SUMMARY_MODEL);
        expect(summary!.effort).toBeUndefined();

        // Exactly one request, to the summariser model, on the origin the key
        // is bound to, with the key as the broker placeholder and never as a
        // value.
        expect(calls).toHaveLength(1);
        const sent = calls[0]!;
        expect(sent.request.method).toBe("POST");
        expect(sent.request.url).toBe(
          `https://generativelanguage.googleapis.com/v1beta/models/${VOICE_CALL_SUMMARY_MODEL}:generateContent`,
        );
        expect(sent.request.headers?.[VOICE_CALL_SECRET_HEADER]).toBe("{{secret:GEMINI_API_KEY}}");
        expect(JSON.stringify(sent.request)).not.toContain(KEY_VALUE);
        expect(sent.secrets.map((secret) => secret.name)).toEqual(["GEMINI_API_KEY"]);
        // JSON out, and the transcript plus the owner's languages in.
        expect(sent.request.body).toContain('"responseMimeType":"application/json"');
        expect(sent.request.body).toContain("Court three is free from eleven to twelve");
        expect(sent.request.body).toContain("English, French, Arabic and Armenian");

        expect(yield* storedSummary(sql)).toContain("Court 3 is free 11:00-12:00");
        expect(JSON.parse(yield* storedSummary(sql)).model).toBe(VOICE_CALL_SUMMARY_MODEL);
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  it.effect("asks Claude first, and never reaches Google", () => {
    const calls: Array<HttpCall> = [];
    const asked: Array<string> = [];
    return withService(
      {
        calls,
        transcriptJson: GREETING_TRANSCRIPT,
        claude: (prompt) =>
          Effect.sync(() => {
            asked.push(prompt);
            return fromClaude({
              summary: VOICE_CALL_GREETING_SUMMARY,
              points: ["Everything is ready for him"],
              decision: "No change needed",
              open: null,
              shortCall: true,
            });
          }),
      },
      (service, sql) =>
        Effect.gen(function* () {
          const summary = yield* service.summarise(CALL_ID);
          expect(summary).toEqual({
            summary: VOICE_CALL_GREETING_SUMMARY,
            points: [],
            decision: null,
            open: null,
            model: CLAUDE_MODEL,
            effort: "medium",
          });
          // One Claude prompt, carrying the real transcript and the new rules.
          expect(asked).toHaveLength(1);
          expect(asked[0]).toContain("Everything is ready for you.");
          expect(asked[0]).toContain("A greeting, small talk, and the voice's own filler");
          expect(asked[0]).toContain(VOICE_CALL_GREETING_SUMMARY);
          // Google is never asked, so no key is needed and no quota is spent.
          expect(calls).toHaveLength(0);
          expect(JSON.parse(yield* storedSummary(sql))).toEqual({
            summary: VOICE_CALL_GREETING_SUMMARY,
            points: [],
            decision: null,
            open: null,
            model: CLAUDE_MODEL,
            effort: "medium",
          });
          expect(yield* storedAttempts(sql)).toBe(1);
        }),
    );
  });

  it.effect("falls back to Gemini when Claude answers nothing usable", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, claude: () => Effect.succeed(null) }, (service, sql) =>
      Effect.gen(function* () {
        const summary = yield* service.summarise(CALL_ID);
        expect(summary!.summary).toContain("Court 3");
        expect(summary!.model).toBe(VOICE_CALL_SUMMARY_MODEL);
        expect(calls).toHaveLength(1);
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  it.effect("falls back to Gemini when the Claude writer itself fails", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      { calls, claude: () => Effect.fail("TextGenerationError") },
      (service, sql) =>
        Effect.gen(function* () {
          expect(yield* service.summarise(CALL_ID)).not.toBeNull();
          expect(calls).toHaveLength(1);
          expect(JSON.parse(yield* storedSummary(sql)).model).toBe(VOICE_CALL_SUMMARY_MODEL);
        }),
    );
  });

  it.effect("never writes a second time, and never asks Google again", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service) =>
      Effect.gen(function* () {
        yield* service.summarise(CALL_ID);
        const again = yield* service.summarise(CALL_ID);
        expect(again?.summary).toContain("Court 3");
        expect(calls).toHaveLength(1);
      }),
    );
  });

  it.effect("stores the fixed short-call line when Gemini answers the greeting call", () => {
    const calls: Array<HttpCall> = [];
    // The stub is the Gemini fallback: it answers with the fixed sentence, and
    // (as the real one did on 16 Oct) also tries to keep the voice's own
    // reassurance as a point and invents a decision. The worker must store
    // neither.
    const answer = (): VoiceCallMintOutcome => ({
      status: 200,
      token: null,
      body: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summary: VOICE_CALL_GREETING_SUMMARY,
                    points: ["Everything is ready for him"],
                    decision: "No change needed",
                    open: null,
                    shortCall: true,
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    return withService({ calls, transcriptJson: GREETING_TRANSCRIPT, answer }, (service, sql) =>
      Effect.gen(function* () {
        const summary = yield* service.summarise(CALL_ID);
        expect(summary).toEqual({
          summary: VOICE_CALL_GREETING_SUMMARY,
          points: [],
          decision: null,
          open: null,
          model: VOICE_CALL_SUMMARY_MODEL,
        });
        // The real two lines went out, with the new rule and the fixed sentence.
        const body = calls[0]!.request.body ?? "";
        expect(body).toContain("Everything is ready for you.");
        expect(body).toContain("A greeting, small talk, and the voice's own filler");
        expect(body).toContain(VOICE_CALL_GREETING_SUMMARY);
        expect(JSON.parse(yield* storedSummary(sql))).toEqual({
          summary: VOICE_CALL_GREETING_SUMMARY,
          points: [],
          decision: null,
          open: null,
          model: VOICE_CALL_SUMMARY_MODEL,
        });
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  // Finding 8: the primary answered, so the old code stopped there, even
  // though its answer could not be parsed.
  it.effect("tries the fallback model when the primary's answer is unusable", () => {
    const calls: Array<HttpCall> = [];
    const models: Array<string> = [];
    return withService(
      {
        calls,
        answer: (model) => {
          models.push(model);
          return model === VOICE_CALL_SUMMARY_MODEL ? unusable() : good();
        },
      },
      (service) =>
        Effect.gen(function* () {
          const summary = yield* service.summarise(CALL_ID);
          expect(summary).not.toBeNull();
          expect(models).toEqual([VOICE_CALL_SUMMARY_MODEL, VOICE_CALL_SUMMARY_FALLBACK_MODEL]);
          expect(summary!.model).toBe(VOICE_CALL_SUMMARY_FALLBACK_MODEL);
        }),
    );
  });

  it.effect("falls back to the second model when the first refuses", () => {
    const calls: Array<HttpCall> = [];
    const models: Array<string> = [];
    return withService(
      {
        calls,
        answer: (model) => {
          models.push(model);
          return model === VOICE_CALL_SUMMARY_MODEL
            ? { status: 429, token: null, body: '{"error":{"message":"quota"}}' }
            : good();
        },
      },
      (service) =>
        Effect.gen(function* () {
          const summary = yield* service.summarise(CALL_ID);
          expect(summary).not.toBeNull();
          expect(models).toEqual([VOICE_CALL_SUMMARY_MODEL, VOICE_CALL_SUMMARY_FALLBACK_MODEL]);
          expect(summary!.model).toBe(VOICE_CALL_SUMMARY_FALLBACK_MODEL);
        }),
    );
  });

  it.effect("a malformed answer from both models leaves the card with its transcript", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, answer: () => unusable() }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(yield* storedSummary(sql)).toBe("");
        expect(calls).toHaveLength(2);
        // An unusable answer IS an attempt: it is what the cap counts.
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  it.effect("an answer with no text at all is no summary", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      { calls, answer: () => ({ status: 200, token: null, body: '{"candidates":[]}' }) },
      (service, sql) =>
        Effect.gen(function* () {
          expect(yield* service.summarise(CALL_ID)).toBeNull();
          expect(yield* storedSummary(sql)).toBe("");
        }),
    );
  });

  it.effect("a refused or failed transport is no summary, never an error", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, throws: true }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(yield* storedSummary(sql)).toBe("");
      }),
    );
  });

  // Finding 5, restated for the Claude-first order (1.66.61): the Gemini key is
  // the *fallback's* credential, so its absence no longer blocks a summary at
  // all. Claude answers, Google is never asked, and no key is read.
  it.effect("summarises from Claude even when no Gemini key is saved", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        withKey: false,
        claude: () =>
          Effect.succeed(
            fromClaude({
              summary:
                "He asked whether a court was free; the voice said Court 3 is free 11:00-12:00.",
              points: ["The voice said Court 3 is free 11:00-12:00 on Saturday"],
              decision: "No change, he just wanted to know",
              open: null,
              shortCall: false,
            }),
          ),
      },
      (service, sql) =>
        Effect.gen(function* () {
          const summary = yield* service.summarise(CALL_ID);
          expect(summary!.model).toBe(CLAUDE_MODEL);
          expect(summary!.points).toHaveLength(1);
          expect(calls).toHaveLength(0);
          expect(JSON.parse(yield* storedSummary(sql)).model).toBe(CLAUDE_MODEL);
          expect(yield* storedAttempts(sql)).toBe(1);
        }),
    );
  });

  // The broken-configuration corner: Claude cannot answer and Google has no
  // key. Nothing is written, and the attempt is the Claude one that went out.
  // (A stored call implies a Gemini key existed when it was made: the call
  // itself cannot start without one.)
  it.effect("writes nothing, and spends one attempt, when Claude fails and no key is saved", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, withKey: false }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(calls).toHaveLength(0);
        expect(yield* storedSummary(sql)).toBe("");
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  it.effect("asks for nothing at all when the call has no transcript", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, transcriptJson: "[]" }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(calls).toHaveLength(0);
        expect(yield* storedSummary(sql)).toBe("");
        expect(yield* storedAttempts(sql)).toBe(0);
      }),
    );
  });

  it.effect("asks for nothing for a call that is not there", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service) =>
      Effect.gen(function* () {
        expect(yield* service.summarise("no-such-call")).toBeNull();
        expect(calls).toHaveLength(0);
      }),
    );
  });

  // Finding 2: Harout, 16 Oct: only a team lead takes calls, so only a team
  // lead has calls worth summarising.
  it.effect("asks for nothing when the bot is not a team lead", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, botIsLead: false }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(calls).toHaveLength(0);
        expect(yield* storedAttempts(sql)).toBe(0);
      }),
    );
  });

  // Finding 1: the chat had a site the owner marked sensitive open. From
  // 1.66.61 the transcript would otherwise have gone to Claude first, so the
  // same gate has to stop that too: nothing leaves the laptop, Claude included.
  it.effect("sends nothing anywhere once the chat is sensitive, and never retries it", () => {
    const calls: Array<HttpCall> = [];
    let claudeAsked = 0;
    return withService(
      {
        calls,
        exposed: ["the bank"],
        claude: () =>
          Effect.sync(() => {
            claudeAsked += 1;
            return null;
          }),
      },
      (service, sql) =>
        Effect.gen(function* () {
          expect(yield* service.summarise(CALL_ID)).toBeNull();
          expect(calls).toHaveLength(0);
          expect(claudeAsked).toBe(0);
          // Not an attempt: this is a refusal, not a failure, so the cap is not
          // spent on it.
          expect(yield* storedAttempts(sql)).toBe(0);
          expect(yield* storedSummary(sql)).toBe("");
        }),
    );
  });

  it.effect("sees taint that lives on the chat's task root, not the chat itself", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, exposedRootTaskId: "root-task-1" }, (service) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(calls).toHaveLength(0);
      }),
    );
  });

  // Astra re-check R1: the task association was folded to "no task" when the
  // lookup failed, so an unreadable root key went unchecked. Fail closed.
  it.effect("treats an unreadable task association as exposed and sends nothing", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, taskLookupFails: true }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(calls).toHaveLength(0);
        expect(yield* storedSummary(sql)).toBe("");
        expect(yield* storedAttempts(sql)).toBe(0);
      }),
    );
  });

  // Astra re-check R1: the gate ran once at the start, so a chat that turned
  // sensitive while the worker waited still reached Google on the next request.
  it.effect("rechecks exposure before the fallback request and never sends it", () => {
    const calls: Array<HttpCall> = [];
    const expose = (sql: SqlClient.SqlClient) =>
      sql`
        INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
        VALUES (${`thread:${CTO_CHAT}`}, 'source', 'the bank', '2026-10-16T14:02:06.000Z')
      `.pipe(Effect.asVoid);
    return withService(
      {
        calls,
        // The primary answers with something unusable, so the code wants the
        // fallback: the recheck must stop it.
        answer: (model) => (model === VOICE_CALL_SUMMARY_MODEL ? unusable() : good()),
        onAnswer: (model, sql) => (model === VOICE_CALL_SUMMARY_MODEL ? expose(sql) : Effect.void),
      },
      (service, sql) =>
        Effect.gen(function* () {
          expect(yield* service.summarise(CALL_ID)).toBeNull();
          // Exactly one request: the primary. The fallback was never asked.
          expect(calls).toHaveLength(1);
          expect(yield* storedSummary(sql)).toBe("");
        }),
    );
  });

  it.effect(
    "rechecks exposure before the fallback, and the late refusal sends nothing to Google",
    () => {
      const calls: Array<HttpCall> = [];
      const expose = (sql: SqlClient.SqlClient) =>
        sql`
        INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
        VALUES (${`thread:${CTO_CHAT}`}, 'source', 'the bank', '2026-10-16T14:02:06.000Z')
      `.pipe(Effect.asVoid);
      return withService({ calls, onSecrets: expose }, (service, sql) =>
        Effect.gen(function* () {
          expect(yield* service.summarise(CALL_ID)).toBeNull();
          // The chat turned sensitive while the fallback's key was being read,
          // after Claude had already been asked (and had failed). Google is
          // never reached, nothing is written, and the one attempt is Claude's.
          expect(calls).toHaveLength(0);
          expect(yield* storedSummary(sql)).toBe("");
          expect(yield* storedAttempts(sql)).toBe(1);
        }),
      );
    },
  );

  // Finding 1: the relay query used a time window, so a typed message during
  // the call was sent to Google as if the call had said it.
  it.effect("carries only the messages the voice relayed for THIS call", () => {
    const calls: Array<HttpCall> = [];
    const relayContext = (callId: string) =>
      JSON.stringify({
        version: 1,
        records: [
          {
            version: 1,
            contextId: "personal-voice-call",
            label: "From the call",
            kind: "personal-voice-call",
            payload: { callId, source: "voice_call" },
          },
        ],
      });
    return withService({ calls }, (service, sql) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at, context_json
          ) VALUES
            ('m-relayed', ${CTO_CHAT}, 'user', 'Relayed by this call', 0,
             '2026-10-16T14:00:30.000Z', '2026-10-16T14:00:30.000Z', ${relayContext(CALL_ID)}),
            ('m-other-call', ${CTO_CHAT}, 'user', ${`Other call ${PRIVATE}`}, 0,
             '2026-10-16T14:00:31.000Z', '2026-10-16T14:00:31.000Z',
             ${relayContext("another-call-id")}),
            ('m-typed', ${CTO_CHAT}, 'user', ${`Typed during the call ${PRIVATE}`}, 0,
             '2026-10-16T14:00:32.000Z', '2026-10-16T14:00:32.000Z', NULL)
        `;
        yield* service.summarise(CALL_ID);
        expect(calls).toHaveLength(1);
        const body = calls[0]!.request.body ?? "";
        expect(body).toContain("Relayed by this call");
        expect(body).not.toContain("Other call");
        expect(body).not.toContain("Typed during the call");
        expect(body).not.toContain(PRIVATE);
      }),
    );
  });
});

describe("PersonalVoiceCallSummaryService.sweep", () => {
  it.effect("finds the card that needs a summary, and then has nothing left to do", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service) =>
      Effect.gen(function* () {
        expect(yield* service.sweep()).toBe(1);
        expect(yield* service.sweep()).toBe(0);
        expect(calls).toHaveLength(1);
      }),
    );
  });

  // Finding 5: the cap and the wait are both real, and the count survives the
  // process (it is a column), so a restart cannot start over.
  it.effect("waits about a minute before retrying, and stops at the cap", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, answer: () => down() }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.sweep()).toBe(1);
        expect(calls).toHaveLength(2);
        expect(yield* storedAttempts(sql)).toBe(1);
        // Straight away again: inside the retry window, so nothing happens.
        expect(yield* service.sweep()).toBe(0);
        expect(calls).toHaveLength(2);
        yield* TestClock.adjust(VOICE_CALL_SUMMARY_RETRY_MS + 1_000);
        expect(yield* service.sweep()).toBe(1);
        yield* TestClock.adjust(VOICE_CALL_SUMMARY_RETRY_MS + 1_000);
        expect(yield* service.sweep()).toBe(1);
        expect(calls).toHaveLength(2 * VOICE_CALL_SUMMARY_MAX_ATTEMPTS);
        expect(yield* storedAttempts(sql)).toBe(VOICE_CALL_SUMMARY_MAX_ATTEMPTS);
        // Out of attempts: it is not offered again, even much later.
        yield* TestClock.adjust(VOICE_CALL_SUMMARY_RETRY_MS * 10);
        expect(yield* service.sweep()).toBe(0);
        expect(calls).toHaveLength(2 * VOICE_CALL_SUMMARY_MAX_ATTEMPTS);
      }),
    );
  });

  // Finding 5: five exhausted rows must not starve the calls behind them.
  it.effect("reaches older calls after newer ones have used up their attempts", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, answer: () => down() }, (service, sql) =>
      Effect.gen(function* () {
        // Five newer calls, all out of attempts, in front of the real one.
        for (const index of [0, 1, 2, 3, 4]) {
          yield* sql`
            INSERT INTO personal_voice_calls (
              call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
              end_reason, message_count, voice_name, model, detail, transcript_json,
              created_at, summary_attempts
            )
            VALUES (
              ${`exhausted-${String(index)}`}, ${CTO_CHAT}, ${CTO_BOT},
              ${`2026-10-16T15:0${String(index)}:00.000Z`},
              ${`2026-10-16T15:0${String(index)}:05.000Z`},
              5, 'hung_up', 0, 'Charon', 'gemini-3.8-live', '',
              '[{"speaker":"you","text":"older call","at":"2026-10-16T15:00:00.000Z"}]',
              '2026-10-16T15:01:00.000Z', ${VOICE_CALL_SUMMARY_MAX_ATTEMPTS}
            )
          `;
        }
        const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
        // The exhausted five are not offered at all; the real call still is.
        expect(
          (yield* repository.listNeedingSummary({
            limit: 5,
            maxAttempts: VOICE_CALL_SUMMARY_MAX_ATTEMPTS,
          })).map((row) => row.callId),
        ).toEqual([CALL_ID]);
        expect(yield* service.sweep()).toBe(1);
        expect(calls).toHaveLength(2);
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  it.effect("summarises a call stored before this feature existed, on the first sweep", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service) =>
      Effect.gen(function* () {
        expect(yield* service.sweep()).toBe(1);
        const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
        const stored = yield* repository.get(CALL_ID);
        expect(Option.isSome(stored)).toBe(true);
        expect(Option.getOrNull(stored)?.summary?.points).toHaveLength(3);
      }),
    );
  });

  // The sweep's own account of a broken configuration: Claude cannot answer and
  // no Gemini key is saved, so the first sweep spends its one attempt and the
  // minute wait holds the second one off. The service never turns that into a
  // failed task or a broken card, it just writes nothing.
  it.effect("spends one attempt on the first sweep while Claude and a key are both missing", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, withKey: false }, (service, sql) =>
      Effect.gen(function* () {
        yield* service.sweep();
        yield* service.sweep();
        expect(calls).toHaveLength(0);
        expect(yield* storedAttempts(sql)).toBe(1);
      }),
    );
  });

  // Astra re-check R3: rows that can never be summarised (a sensitive chat here)
  // are skipped, not failed, so without paging five of them would sit in the
  // newest-five window forever and every older eligible call would wait behind
  // them. The sweep must walk past them and still summarise the real call.
  it.effect("pages past permanently ineligible newer calls and reaches the older one", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service, sql) =>
      Effect.gen(function* () {
        // Five newer calls in a chat that had a sensitive site open: newer than
        // CALL_ID, so they fill the whole first page.
        for (const index of [0, 1, 2, 3, 4]) {
          yield* sql`
            INSERT INTO personal_voice_calls (
              call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
              end_reason, message_count, voice_name, model, detail, transcript_json,
              created_at, summary_attempts
            )
            VALUES (
              ${`sensitive-${String(index)}`}, 'thread-sensitive', ${CTO_BOT},
              ${`2026-10-16T15:0${String(index)}:00.000Z`},
              ${`2026-10-16T15:0${String(index)}:05.000Z`},
              5, 'hung_up', 0, 'Charon', 'gemini-3.8-live', '',
              '[{"speaker":"you","text":"the bank account","at":"2026-10-16T15:00:00.000Z"}]',
              '2026-10-16T15:01:00.000Z', 0
            )
          `;
        }
        yield* sql`
          INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
          VALUES ('thread:thread-sensitive', 'source', 'the bank', '2026-10-16T15:02:00.000Z')
        `;
        yield* service.sweep();
        // The real, eligible call was reached and summarised on that one sweep.
        expect(yield* storedSummary(sql)).toContain("Court 3 is free 11:00-12:00");
        expect(calls).toHaveLength(1);
        // The sensitive rows were refused, not failed: no attempt was spent on
        // any of them, so they can still be summarised if the taint is cleared.
        const refused = yield* sql<{ readonly attempts: number }>`
          SELECT summary_attempts AS "attempts" FROM personal_voice_calls
          WHERE call_id LIKE 'sensitive-%'
        `;
        expect(refused.map((row) => Number(row.attempts))).toEqual([0, 0, 0, 0, 0]);
      }),
    );
  });
});

// Finding 7: a decode error carries the row it rejected, and the row holds the
// summary. Only the error's class may be logged.
describe("PersonalVoiceCallSummaryService log hygiene", () => {
  it.effect("never logs the owner's own words when a stored row cannot be decoded", () => {
    const calls: Array<HttpCall> = [];
    const written: Array<string> = [];
    const capture = Logger.layer([
      Logger.make((options) => written.push(JSON.stringify(options.message))),
    ]);
    return withService({ calls }, (_service, sql) =>
      Effect.gen(function* () {
        // A row whose summary is fine but whose sibling column is not: the
        // decode error's payload carries the whole row, summary included.
        yield* sql`
          UPDATE personal_voice_calls
          SET summary_json = ${JSON.stringify({
            summary: PRIVATE,
            points: [],
            decision: null,
            open: null,
          })},
          end_reason = 'not-a-real-reason'
          WHERE call_id = ${CALL_ID}
        `;
        const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
        const rows = yield* repository
          .summariesForTurn({ threadId: CTO_CHAT, limit: 2 })
          .pipe(Effect.provide(capture));
        expect(rows).toEqual([]);
        expect(written.join("\n")).not.toContain(PRIVATE);
      }),
    );
  });
});
