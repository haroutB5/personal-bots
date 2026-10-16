// @effect-diagnostics preferSchemaOverJson:off - the fake transport returns the raw Gemini body, which is the point of the test.
/**
 * The call-summary worker, end to end except Google: the HTTP boundary is a
 * fake transport, so the test proves the exact request (URL, model, the broker
 * placeholder in the header, the transcript in the prompt) and the exact
 * behaviour when the answer is unusable, when Google refuses, when there is no
 * key and when the call has no transcript.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  PersonalBotId,
  ThreadId,
  VOICE_CALL_SECRET_HEADER,
  VOICE_CALL_SUMMARY_FALLBACK_MODEL,
  VOICE_CALL_SUMMARY_MAX_ATTEMPTS,
  VOICE_CALL_SUMMARY_MODEL,
  VOICE_CALL_SUMMARY_RETRY_MS,
} from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import type { BrokerRequest, BrokerSecret, SecretBrokerError } from "../secrets/secretBroker.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import {
  PersonalVoiceCallSummaryService,
  layer as summaryLayer,
} from "./PersonalVoiceCallSummaryService.ts";
import { VoiceCallHttp, type VoiceCallMintOutcome } from "./voiceCallGemini.ts";

const CTO_CHAT = ThreadId.make("thread-call-summary");
const CTO_BOT = PersonalBotId.make("bot-cto");
const CALL_ID = "8f9c3ace-a17b-4086-aa8a-e53058b480a9";
const KEY_VALUE = "AIza-TEST-ONLY-KEY-VALUE";

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

interface HttpCall {
  readonly request: BrokerRequest;
  readonly secrets: ReadonlyArray<BrokerSecret>;
}

interface HarnessOptions {
  readonly calls: Array<HttpCall>;
  /** What the fake transport answers; `null` returns 200 with a body that has no text. */
  readonly answer?: (model: string) => VoiceCallMintOutcome;
  /** Make the transport itself fail, as a broker refusal does. */
  readonly throws?: boolean;
  /** The saved key; `null` means no Gemini key at all. */
  readonly withKey?: boolean;
  /** The bot's own transcript; `null` seeds a call with no transcript lines. */
  readonly transcriptJson?: string | null;
}

const good = (): VoiceCallMintOutcome => ({
  status: 200,
  token: null,
  body: JSON.stringify({ candidates: [{ content: { parts: [{ text: GOOD_ANSWER }] } }] }),
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
  return summaryLayer.pipe(
    Layer.provideMerge(PersonalVoiceCallRepository.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
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
    Layer.provideMerge(
      Layer.succeed(PersonalSessionAccess.PersonalSessionAccess, {
        forThread: () => Effect.succeed({ botId: null, environment: {}, systemInstructions: null }),
        secretsForThread: () => Effect.succeed(saved),
        sharedSecrets: () => Effect.succeed(saved),
        instructionsForThread: () => Effect.succeed(null),
      } satisfies PersonalSessionAccess.PersonalSessionAccess["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(VoiceCallHttp, {
        call: (request: BrokerRequest, secrets: ReadonlyArray<BrokerSecret>) =>
          options.throws === true
            ? Effect.fail({
                _tag: "SecretBrokerError",
                message: "no saved key named",
              } as unknown as SecretBrokerError)
            : Effect.sync(() => {
                options.calls.push({ request, secrets });
                const model = /models\/([^:]+):/.exec(request.url)?.[1] ?? "";
                return options.answer?.(model) ?? good();
              }),
      } satisfies VoiceCallHttp["Service"]),
    ),
  );
};

/** The bot and one finished call card, exactly as the live database holds them. */
const seed = (options: HarnessOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transcript =
      options.transcriptJson === undefined ? REAL_TRANSCRIPT : options.transcriptJson;
    const now = "2026-10-16T14:02:06.000Z";
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at, allow_voice_calls
      )
      VALUES (
        ${CTO_BOT}, 'CTO', '', '', 'blob', '#1A73E8',
        '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0, ${now}, ${now}, 1
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

describe("PersonalVoiceCallSummaryService.summarise", () => {
  it.effect("writes the summary for the real transcript, from one Gemini text call", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service, sql) =>
      Effect.gen(function* () {
        const summary = yield* service.summarise(CALL_ID);
        expect(summary).not.toBeNull();
        expect(summary!.summary).toContain("Court 3 is free 11:00-12:00");
        expect(summary!.points).toHaveLength(3);
        expect(summary!.decision).toBe("No change, he just wanted to know");

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

        // Stored on the card, and readable back through the repository.
        const raw = yield* storedSummary(sql);
        expect(raw).toContain("Court 3 is free 11:00-12:00");
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
        }),
    );
  });

  it.effect("a malformed answer leaves the card with its transcript and does not crash", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        answer: () => ({
          status: 200,
          token: null,
          body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "{not json" }] } }] }),
        }),
      },
      (service, sql) =>
        Effect.gen(function* () {
          expect(yield* service.summarise(CALL_ID)).toBeNull();
          expect(yield* storedSummary(sql)).toBe("");
          // The model answered; its answer just was not a summary. Asking the
          // second model the same question would not help, so only the primary
          // was asked, and the card keeps its transcript.
          expect(calls).toHaveLength(1);
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

  it.effect("asks for nothing at all when the key is missing or not brokered", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, withKey: false }, (service, sql) =>
      Effect.gen(function* () {
        expect(yield* service.summarise(CALL_ID)).toBeNull();
        expect(calls).toHaveLength(0);
        expect(yield* storedSummary(sql)).toBe("");
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

  it.effect("waits about a minute before retrying, and gives up after the cap", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        answer: () => ({ status: 500, token: null, body: '{"error":{"message":"down"}}' }),
      },
      (service) =>
        Effect.gen(function* () {
          expect(yield* service.sweep()).toBe(1);
          // Both models, once.
          expect(calls).toHaveLength(2);
          // Straight away again: inside the retry window, so nothing happens.
          expect(yield* service.sweep()).toBe(0);
          expect(calls).toHaveLength(2);
          yield* TestClock.adjust(VOICE_CALL_SUMMARY_RETRY_MS + 1_000);
          expect(yield* service.sweep()).toBe(1);
          yield* TestClock.adjust(VOICE_CALL_SUMMARY_RETRY_MS + 1_000);
          expect(yield* service.sweep()).toBe(1);
          expect(calls).toHaveLength(2 * VOICE_CALL_SUMMARY_MAX_ATTEMPTS);
          // The cap is reached: the card keeps its transcript for good.
          yield* TestClock.adjust(VOICE_CALL_SUMMARY_RETRY_MS * 10);
          expect(yield* service.sweep()).toBe(0);
          expect(calls).toHaveLength(2 * VOICE_CALL_SUMMARY_MAX_ATTEMPTS);
        }),
    );
  });

  it.effect("summarises a call stored before this feature existed, on the first sweep", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls }, (service) =>
      Effect.gen(function* () {
        // The seeded card is exactly that: transcript, no summary, older than
        // the worker. One sweep is the backfill.
        expect(yield* service.sweep()).toBe(1);
        const rows = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
        const stored = yield* rows.get(CALL_ID);
        expect(Option.isSome(stored)).toBe(true);
        expect(Option.getOrNull(stored)?.summary?.points).toHaveLength(3);
      }),
    );
  });
});
