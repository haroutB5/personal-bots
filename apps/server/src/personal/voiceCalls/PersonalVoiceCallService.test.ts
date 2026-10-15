// @effect-diagnostics preferSchemaOverJson:off - the assertions read the raw JSON the broker would send, and the raw response shape.
/**
 * The voice-call server path, end to end except Google: the HTTP boundary is a
 * fake transport that records the exact broker request, so the test proves the
 * key goes in as the broker placeholder (never the value), that `send` posts
 * one real user turn carrying the call marker, and that `finish` stores one
 * card per call id and never a chat message.
 */
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_VOICE_CALL_CONTEXT_KIND,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  VOICE_CALL_SECRET_HEADER,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalLoginRequestRepository from "../secrets/PersonalLoginRequestRepository.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import type { BrokerRequest, BrokerSecret } from "../secrets/secretBroker.ts";
import { PersonalVoiceCallService, layer as voiceCallLayer } from "./PersonalVoiceCallService.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import { VoiceCallHttp, type VoiceCallMintOutcome } from "./voiceCallGemini.ts";

const CTO_CHAT = ThreadId.make("thread-cto-chat");
const OTHER_CHAT = ThreadId.make("thread-other-chat");
const CTO_BOT = PersonalBotId.make("bot-cto");
/** A value the test can search for: if it ever appears, the key leaked. */
const KEY_VALUE = "AIza-TEST-ONLY-KEY-VALUE";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

/** The broker request the service built, as the fake transport saw it. */
interface HttpCall {
  readonly request: BrokerRequest;
  readonly secrets: ReadonlyArray<BrokerSecret>;
}

const setSwitch = (botId: PersonalBotId, allow: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE personal_bots SET allow_voice_calls = ${allow ? 1 : 0} WHERE bot_id = ${botId}`;
  });

const seedChats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const [botId, name, allow] of [
    [CTO_BOT, "CTO", true],
    [PersonalBotId.make("bot-qa"), "QA", false],
  ] as const) {
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at, allow_voice_calls
      )
      VALUES (
        ${botId}, ${name}, '', '', 'blob', '#1A73E8',
        ${JSON.stringify(modelSelection)}, 1, 0, ${now}, ${now}, ${allow ? 1 : 0}
      )
    `;
  }
  for (const [threadId, title] of [
    [CTO_CHAT, "Main"],
    [OTHER_CHAT, "QA chat"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, 'personal', ${title}, ${now}, ${now})
    `;
  }
  yield* sql`
    INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
    VALUES (${CTO_CHAT}, ${CTO_BOT}, ${now}), (${OTHER_CHAT}, 'bot-qa', ${now})
  `;
});

const makeHarness = (options: {
  readonly calls: Array<HttpCall>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly mint?: () => VoiceCallMintOutcome;
  readonly secret?: PersonalSessionAccess.PersonalSessionSecret | null;
}) => {
  const key: PersonalSessionAccess.PersonalSessionSecret = options.secret ?? {
    name: "GEMINI_API_KEY",
    mode: "brokered",
    origins: ["https://generativelanguage.googleapis.com"],
    placement: { header: VOICE_CALL_SECRET_HEADER },
    value: KEY_VALUE,
  };
  const saved = options.secret === null ? [] : [key];
  return voiceCallLayer.pipe(
    Layer.provideMerge(PersonalVoiceCallRepository.layer),
    Layer.provideMerge(PersonalSecretRepository.layer),
    Layer.provideMerge(PersonalLoginRequestRepository.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.mock(PersonalBotService.PersonalBotService)({
        getProfile: () =>
          Effect.succeed({
            displayName: "Harout",
            autoArchiveTaskChats: true,
            voiceCalls: { voiceName: "Kore", quietHangupMinutes: 5 },
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
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            options.dispatched.push(command);
            return { sequence: options.dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.some({
              id: threadId,
              title: "Main",
              archivedAt: null,
              runtimeMode: "full-access",
              interactionMode: "default",
              modelSelection,
              session: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            }),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(VoiceCallHttp, {
        call: (request: BrokerRequest, secrets: ReadonlyArray<BrokerSecret>) =>
          Effect.sync(() => {
            options.calls.push({ request, secrets });
            return (
              options.mint?.() ?? {
                status: 200,
                token: "auth_tokens/test-single-use",
                body: '{"name":"auth_tokens/test-single-use"}',
              }
            );
          }),
      } satisfies VoiceCallHttp["Service"]),
    ),
  );
};

const withService = <A, E>(
  options: Parameters<typeof makeHarness>[0],
  body: (service: PersonalVoiceCallService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* seedChats;
    const service = yield* PersonalVoiceCallService;
    return yield* body(service);
  }).pipe(Effect.provide(makeHarness(options)));

const turnStarts = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

describe("PersonalVoiceCallService.start", () => {
  it.effect("mints one token and hands the phone a pass, never the key", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, dispatched: [] }, (service) =>
      Effect.gen(function* () {
        const started = yield* service.start({ threadId: CTO_CHAT });
        expect(started.token).toBe("auth_tokens/test-single-use");
        expect(started.model).toBe("gemini-3.8-live");
        expect(started.fallbackModel).toBe("gemini-3.1-flash-live-preview");
        expect(started.maxCallMinutes).toBe(30);
        expect(started.botName).toBe("CTO");
        // The owner's own Settings, not the defaults.
        expect(started.voiceName).toBe("Kore");
        expect(started.quietHangupMinutes).toBe(5);
        expect(started.systemInstruction).toContain("You ARE CTO");
        expect(started.context.displayName).toBe("Harout");
        // The key is nowhere in what the phone receives.
        expect(JSON.stringify(started)).not.toContain(KEY_VALUE);

        // Exactly one request to Google, and the key went in as the broker
        // placeholder in the header the key is bound to.
        expect(calls).toHaveLength(1);
        const sent = calls[0]!;
        expect(sent.request.url).toBe(
          "https://generativelanguage.googleapis.com/v1alpha/auth_tokens",
        );
        expect(sent.request.headers?.[VOICE_CALL_SECRET_HEADER]).toBe("{{secret:GEMINI_API_KEY}}");
        expect(JSON.stringify(sent.request)).not.toContain(KEY_VALUE);
        expect(sent.secrets.map((secret) => secret.name)).toEqual(["GEMINI_API_KEY"]);
        // The token is single use and locked to the cap.
        expect(JSON.parse(sent.request.body!)).toMatchObject({ uses: 1 });
      }),
    );
  });

  it.effect("refuses a bot whose Allow voice calls switch is off", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, dispatched: [] }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.start({ threadId: OTHER_CHAT }));
        expect(error.code).toBe("calls_not_allowed");
        // Nothing was minted and nothing was spent.
        expect(calls).toHaveLength(0);
      }),
    );
  });

  it.effect("says there is no key rather than failing vaguely", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, dispatched: [], secret: null }, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.start({ threadId: CTO_CHAT }));
        expect(error.code).toBe("no_key");
        expect(calls).toHaveLength(0);
      }),
    );
  });

  it.effect("reads a refused key as key_rejected and an out-of-quota key as key_quota", () => {
    const calls: Array<HttpCall> = [];
    return withService(
      {
        calls,
        dispatched: [],
        mint: () => ({
          status: 429,
          token: null,
          body: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}',
        }),
      },
      (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.start({ threadId: CTO_CHAT }));
          expect(error.code).toBe("key_quota");
        }),
    );
  });

  it.effect("rate limits a loop so it cannot burn the quota", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, dispatched: [] }, (service) =>
      Effect.gen(function* () {
        for (let index = 0; index < 6; index += 1) {
          yield* service.start({ threadId: CTO_CHAT });
        }
        const error = yield* Effect.flip(service.start({ threadId: CTO_CHAT }));
        expect(error.code).toBe("rate_limited");
        expect(calls).toHaveLength(6);
      }),
    );
  });

  it.effect("reports the key state for Settings without a chat", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, dispatched: [] }, (service) =>
      Effect.gen(function* () {
        const check = yield* service.checkKey();
        expect(check.status).toBe("ok");
        expect(check.origin).toBe("https://generativelanguage.googleapis.com");
      }),
    );
  });

  it.effect("says a key is missing when Settings has none", () => {
    const calls: Array<HttpCall> = [];
    return withService({ calls, dispatched: [], secret: null }, (service) =>
      Effect.gen(function* () {
        const check = yield* service.checkKey();
        expect(check.status).toBe("missing");
      }),
    );
  });
});

describe("PersonalVoiceCallService.send", () => {
  it.effect("posts the spoken words as the owner's own turn, tagged with the call", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return withService({ calls: [], dispatched }, (service) =>
      Effect.gen(function* () {
        const started = yield* service.start({ threadId: CTO_CHAT });
        const sent = yield* service.send({
          threadId: CTO_CHAT,
          callId: started.callId,
          text: "  check the gates  ",
        });
        const starts = turnStarts(dispatched);
        expect(starts).toHaveLength(1);
        const turn = starts[0]!;
        expect(turn.threadId).toBe(CTO_CHAT);
        expect(turn.message.messageId).toBe(sent.messageId);
        expect(turn.message.role).toBe("user");
        // Trimmed, exactly as a typed send would carry it.
        expect(turn.message.text).toBe("check the gates");
        expect(turn.message.attachments).toEqual([]);
        const marker = turn.message.context?.records[0] as {
          kind: string;
          payload: { callId: string; source: string };
        };
        expect(marker.kind).toBe(PERSONAL_VOICE_CALL_CONTEXT_KIND);
        expect(marker.payload).toEqual({ callId: started.callId, source: "voice_call" });
        // The turn carries the chat's own runtime and interaction modes.
        expect(turn.runtimeMode).toBe("full-access");
        expect(turn.interactionMode).toBe("default");
        // A send posts exactly one turn and nothing else: `start` dispatches
        // nothing, and the call card is not written until `finish`.
        expect(dispatched).toHaveLength(1);
      }),
    );
  });

  it.effect("refuses an empty or oversized message", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return withService({ calls: [], dispatched }, (service) =>
      Effect.gen(function* () {
        const started = yield* service.start({ threadId: CTO_CHAT });
        const empty = yield* Effect.flip(
          service.send({ threadId: CTO_CHAT, callId: started.callId, text: "   " }),
        );
        expect(empty.code).toBe("invalid_input");
        const huge = yield* Effect.flip(
          service.send({ threadId: CTO_CHAT, callId: started.callId, text: "x".repeat(4_001) }),
        );
        expect(huge.code).toBe("invalid_input");
        expect(turnStarts(dispatched)).toHaveLength(0);
      }),
    );
  });
});

describe("PersonalVoiceCallService.finish and list", () => {
  it.effect("stores one card per call, keeps it out of the chat, and is idempotent", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return withService({ calls: [], dispatched }, (service) =>
      Effect.gen(function* () {
        const started = yield* service.start({ threadId: CTO_CHAT });
        const sent = yield* service.send({
          threadId: CTO_CHAT,
          callId: started.callId,
          text: "check the gates",
        });
        const startedAt = DateTime.makeUnsafe("2026-10-15T17:00:00.000Z");
        const endedAt = DateTime.makeUnsafe("2026-10-15T17:04:12.000Z");
        const first = yield* service.finish({
          threadId: CTO_CHAT,
          callId: started.callId,
          startedAt,
          endedAt,
          endReason: "hung_up",
          transcript: [
            { speaker: "you", text: "check the gates", at: startedAt },
            { speaker: "voice", text: "Sending that to CTO.", at: startedAt },
          ],
          sentMessageIds: [sent.messageId],
        });
        expect(first.alreadyStored).toBe(false);
        expect(first.call.durationSeconds).toBe(252);
        expect(first.call.messageCount).toBe(1);
        expect(first.call.botId).toBe(CTO_BOT);
        expect(first.call.transcript).toHaveLength(2);

        // A second finish (a retried flush) writes nothing and returns the same card.
        const again = yield* service.finish({
          threadId: CTO_CHAT,
          callId: started.callId,
          startedAt,
          endedAt,
          endReason: "dropped",
          transcript: [],
          sentMessageIds: [],
        });
        expect(again.alreadyStored).toBe(true);
        expect(again.call.endReason).toBe("hung_up");

        const listed = yield* service.list({ threadId: CTO_CHAT });
        expect(listed.calls).toHaveLength(1);
        expect(listed.calls[0]!.callId).toBe(started.callId);

        // The card never became a chat message: writing it dispatches nothing,
        // so the only turn in this whole call is the one `send` posted.
        expect(turnStarts(dispatched)).toHaveLength(1);
      }),
    );
  });
});
