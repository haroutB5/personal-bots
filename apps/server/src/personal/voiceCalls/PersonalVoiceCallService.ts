/**
 * Voice calls with a bot: the server half of Harout's Gemini Live feature.
 *
 * - `start` mints one single-use Live token from the saved `GEMINI_API_KEY`
 *   through the secret broker (the value never enters this process's logs, a
 *   response or the phone) and returns everything the client needs, including
 *   the system instruction built here.
 * - `send` posts what the owner said into the chat as his own normal message
 *   and starts the bot's turn exactly like a typed send, with a
 *   `personal-voice-call` marker so the client can tag it "From the call".
 * - `finish` stores ONE call card per `callId`, in its own table. That record
 *   is never a chat message, so no bot's model context ever contains the
 *   transcript.
 * - `list` hands the chat its cards, which the client places at `startedAt`.
 *
 * Owner chats only: a bot chat whose "Allow voice calls" switch is on, not
 * archived, not a group relay, not a task or routine chat. `start` is rate
 * limited so a loop cannot burn the quota.
 */
import * as NodeCrypto from "node:crypto";

import {
  botAllowsVoiceCalls,
  ComposerContextId,
  CommandId,
  MessageId,
  PERSONAL_VOICE_CALL_CONTEXT_KIND,
  profileVoiceCallSettings,
  ThreadId,
  VOICE_CALL_CONTEXT_MESSAGES,
  VOICE_CALL_DEFAULT_VOICE,
  VOICE_CALL_FALLBACK_MODEL,
  VOICE_CALL_MAX_MINUTES,
  VOICE_CALL_MAX_SENT_CHARS,
  VOICE_CALL_MAX_TRANSCRIPT_CHARS,
  VOICE_CALL_MAX_TRANSCRIPT_ENTRIES,
  VOICE_CALL_MODEL,
  VOICE_CALL_NEW_SESSION_TTL_SECONDS,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  VOICE_CALL_STARTS_PER_MINUTE,
  VOICE_CALL_TOKEN_TTL_SECONDS,
  isVoiceCallVoice,
  type OrchestrationMessageContext,
  type OrchestrationThreadShell,
  type PersonalBot,
  type VoiceCallContextMessage,
  type VoiceCallErrorCode,
  type VoiceCallFinishResult,
  type VoiceCallKeyCheckResult,
  type VoiceCallListResult,
  type VoiceCallRecord,
  type VoiceCallSendResult,
  type VoiceCallStartResult,
  type VoiceCallTranscriptEntry,
  PersonalVoiceCallsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalLoginRequestRepository from "../secrets/PersonalLoginRequestRepository.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import type { SecretBrokerError } from "../secrets/secretBroker.ts";
import { personalWorkingProgress } from "../workingProgress.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import { createVoiceCallRateLimiter } from "./voiceCallRateLimit.ts";
import * as VoiceCallGemini from "./voiceCallGemini.ts";
import { voiceCallSystemInstruction } from "./voiceCallInstructions.ts";

/** At most this many cards are returned for one chat. */
export const VOICE_CALL_LIST_LIMIT = 50;

/** The window the start limit is counted over. */
export const VOICE_CALL_START_WINDOW_MS = 60_000;

/**
 * A server-written row that is machinery, not conversation: a usage-limit
 * pause, an auto-continue, a release notice, a task's own hand-over line. The
 * voice has no business reading them aloud.
 */
export const isServerOnlyNotice = (text: string): boolean => {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("Release notice from the app") ||
    /^\[(Routine task|Delegated task from|Task from you)\]/.test(trimmed) ||
    /^Auto-continue/.test(trimmed)
  );
};

const fail = (code: VoiceCallErrorCode, message: string, cause?: unknown) =>
  new PersonalVoiceCallsError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export class PersonalVoiceCallService extends Context.Service<
  PersonalVoiceCallService,
  {
    readonly start: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<VoiceCallStartResult, PersonalVoiceCallsError>;
    readonly checkKey: () => Effect.Effect<VoiceCallKeyCheckResult, PersonalVoiceCallsError>;
    readonly send: (input: {
      readonly threadId: ThreadId;
      readonly callId: string;
      readonly text: string;
    }) => Effect.Effect<VoiceCallSendResult, PersonalVoiceCallsError>;
    readonly finish: (input: {
      readonly threadId: ThreadId;
      readonly callId: string;
      readonly startedAt: DateTime.Utc;
      readonly endedAt: DateTime.Utc;
      readonly endReason: VoiceCallRecord["endReason"];
      readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
      readonly sentMessageIds: ReadonlyArray<string>;
      readonly detail?: string | undefined;
    }) => Effect.Effect<VoiceCallFinishResult, PersonalVoiceCallsError>;
    readonly list: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<VoiceCallListResult, PersonalVoiceCallsError>;
  }
>()("t3/personal/voiceCalls/PersonalVoiceCallService") {}

/** A callable chat: the bot, the chat's own facts and its shell. */
interface CallableChat {
  readonly bot: PersonalBot;
  readonly botId: PersonalBot["botId"];
  readonly threadId: ThreadId;
  readonly shell: OrchestrationThreadShell;
}

export const make = Effect.gen(function* () {
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const botService = yield* PersonalBotService.PersonalBotService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const sessions = yield* PersonalSessionAccess.PersonalSessionAccess;
  const calls = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
  const secrets = yield* PersonalSecretRepository.PersonalSecretRepository;
  const loginRequests = yield* PersonalLoginRequestRepository.PersonalLoginRequestRepository;
  const http = yield* VoiceCallGemini.VoiceCallHttp;
  const sql = yield* SqlClient.SqlClient;

  const startLimiter = createVoiceCallRateLimiter({
    limit: VOICE_CALL_STARTS_PER_MINUTE,
    windowMs: VOICE_CALL_START_WINDOW_MS,
  });
  // One start at a time: two taps must not mint two tokens and two call ids
  // for the one call the owner thinks he made.
  const startLock = yield* Semaphore.make(1);

  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

  /**
   * The chat must be one the owner is in on his own: a bot chat with the
   * switch on, not archived, not deleted, not a group relay, not a chat made
   * for a task or a routine. Every refusal names the reason the call screen
   * needs.
   */
  const callableChat = (rawThreadId: ThreadId) =>
    Effect.gen(function* () {
      const facts = yield* bots
        .getChatFacts({ threadId: rawThreadId })
        .pipe(Effect.mapError((cause) => fail("not_found", "Could not read that chat.", cause)));
      if (Option.isNone(facts)) {
        return yield* fail("not_owner_chat", "That chat cannot take a call.");
      }
      const chat = facts.value;
      if (chat.archived || chat.deleted || chat.groupRelay || chat.taskChat || chat.routineChat) {
        return yield* fail(
          "not_owner_chat",
          "Calls work in your own chats with a bot, not in group, task or archived chats.",
        );
      }
      const bot = yield* bots
        .getBotById({ botId: chat.botId })
        .pipe(Effect.mapError((cause) => fail("not_found", "Could not read that bot.", cause)));
      if (Option.isNone(bot) || !botAllowsVoiceCalls(bot.value)) {
        return yield* fail(
          "calls_not_allowed",
          "This bot cannot take calls. Turn on Allow voice calls on its page.",
        );
      }
      const shell = yield* projections
        .getThreadShellById(chat.threadId)
        .pipe(Effect.mapError((cause) => fail("not_found", "Could not read that chat.", cause)));
      if (Option.isNone(shell)) {
        return yield* fail("not_owner_chat", "That chat cannot take a call.");
      }
      return {
        bot: bot.value,
        botId: bot.value.botId,
        threadId: chat.threadId,
        shell: shell.value,
      } satisfies CallableChat;
    });

  /**
   * The exact key Settings expects: a brokered `GEMINI_API_KEY` bound to
   * Google's endpoint. Anything else is reported as the key being missing or
   * unusable, never as a server fault.
   */
  const requireKey = (
    saved: ReadonlyArray<PersonalSessionAccess.PersonalSessionSecret>,
  ): Effect.Effect<PersonalSessionAccess.PersonalSessionSecret, PersonalVoiceCallsError> => {
    const key = saved.find((secret) => secret.name === VOICE_CALL_SECRET_NAME);
    if (key === undefined) {
      return Effect.fail(
        fail(
          "no_key",
          "Add a Gemini key to call. Settings > Voice calls takes it once, and it stays on your laptop.",
        ),
      );
    }
    if (key.mode !== "brokered" || !key.origins.includes(VOICE_CALL_SECRET_ORIGIN)) {
      return Effect.fail(
        fail(
          "key_rejected",
          `The saved ${VOICE_CALL_SECRET_NAME} is not set up for Gemini Live. Save it as a brokered key bound to ${VOICE_CALL_SECRET_ORIGIN} in Settings > Voice calls.`,
        ),
      );
    }
    return Effect.succeed(key);
  };

  /** Mints one Live token, turning Google's answer and broker refusals into codes. */
  const mint = (key: PersonalSessionAccess.PersonalSessionSecret, ttlSeconds: number) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const request = VoiceCallGemini.voiceCallMintRequest({
        expireTime: DateTime.formatIso(DateTime.add(now, { seconds: Math.max(60, ttlSeconds) })),
        newSessionExpireTime: DateTime.formatIso(
          DateTime.add(now, { seconds: VOICE_CALL_NEW_SESSION_TTL_SECONDS }),
        ),
      });
      const response = yield* http
        .call(request, [key])
        .pipe(
          Effect.catch((error: SecretBrokerError) =>
            Effect.fail(
              fail(
                VoiceCallGemini.voiceCallBrokerRefusalCode(error.message),
                "The Gemini key could not be used.",
                error,
              ),
            ),
          ),
        );
      if (response.status === 200 && response.token !== null) {
        return response.token;
      }
      const code = VoiceCallGemini.voiceCallMintErrorCode(response);
      return yield* fail(
        code,
        code === "key_rejected"
          ? "Google did not accept the Gemini key."
          : code === "key_quota"
            ? "Gemini is out of quota for this key. Try again later."
            : "Google could not be reached right now.",
      );
    });

  /**
   * The cards waiting in this chat, said in one line each. They are named, not
   * read: the voice is told that the chat is holding a login for vercel.com,
   * never its contents.
   */
  const calloutLines = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const pending = yield* secrets
        .listByStatus("pending")
        .pipe(
          Effect.orElseSucceed(
            () => [] as ReadonlyArray<{ readonly name: string; readonly threadId: ThreadId }>,
          ),
        );
      for (const request of pending) {
        if (request.threadId !== threadId) continue;
        lines.push(`a secret called ${request.name}`);
      }
      const logins = yield* loginRequests.list(threadId).pipe(Effect.orElseSucceed(() => []));
      for (const login of logins) {
        if (login.status !== "pending" && login.status !== "filling") continue;
        lines.push(`a login for ${login.origin}`);
      }
      return lines;
    });

  /**
   * The last text messages of the chat, oldest first. Tool steps, reasoning
   * rows and server notices are left out: the voice is told what the
   * conversation said, not what the machinery did.
   */
  const recentMessages = (threadId: ThreadId) =>
    sql<{ readonly role: string; readonly text: string; readonly at: string }>`
      SELECT role AS "role", text AS "text", created_at AS "at"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role IN ('user', 'assistant')
        AND length(trim(text)) > 0
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${VOICE_CALL_CONTEXT_MESSAGES}
    `.pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => !isServerOnlyNotice(row.text))
          .map((row): VoiceCallContextMessage => ({
            role: row.role === "user" ? "user" : "bot",
            text: row.text,
            at: DateTime.makeUnsafe(row.at),
          }))
          .reverse(),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<VoiceCallContextMessage>),
    );

  const voiceName = (settings: { readonly voiceName: string }): string =>
    isVoiceCallVoice(settings.voiceName) ? settings.voiceName : VOICE_CALL_DEFAULT_VOICE;

  const statusOf = (shell: CallableChat["shell"]): string =>
    shell.hasPendingApprovals || shell.hasPendingUserInput
      ? "Waiting on you"
      : shell.session?.status === "running" || shell.session?.status === "starting"
        ? "Working"
        : "Idle";

  const start: PersonalVoiceCallService["Service"]["start"] = (input) =>
    startLock.withPermit(
      Effect.gen(function* () {
        if (!startLimiter.take(yield* nowMs)) {
          return yield* fail(
            "rate_limited",
            "Too many calls started just now. Wait a moment and try again.",
          );
        }
        const chat = yield* callableChat(input.threadId);
        const profile = yield* botService
          .getProfile()
          .pipe(Effect.mapError((cause) => fail("not_found", "Could not read settings.", cause)));
        const settings = profileVoiceCallSettings(profile);
        const saved = yield* sessions.secretsForThread(chat.threadId);
        const key = yield* requireKey(saved);
        // The token has to outlive the whole call, not just its start.
        const ttlSeconds = Math.max(VOICE_CALL_TOKEN_TTL_SECONDS, VOICE_CALL_MAX_MINUTES * 60);
        const token = yield* mint(key, ttlSeconds);
        const notes = yield* personalWorkingProgress(sql, [chat.threadId]).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly note: string }>),
        );
        const context = yield* recentMessages(chat.threadId);
        const callouts = yield* calloutLines(chat.threadId);
        const statusLabel = statusOf(chat.shell);
        const statusDetail = notes[0]?.note ?? "";
        const name = voiceName(settings);
        const startedAt = yield* DateTime.now;
        const callId = NodeCrypto.randomUUID();
        const systemInstruction = voiceCallSystemInstruction({
          botName: chat.bot.name,
          botTitle: chat.bot.title,
          displayName: profile.displayName,
          statusLabel,
          statusDetail,
          recentMessages: context,
          callouts,
          voiceName: name,
        });
        yield* Effect.logInfo("personal voice call minted", {
          threadId: chat.threadId,
          callId,
          botId: chat.botId,
          model: VOICE_CALL_MODEL,
          voice: name,
          contextMessages: context.length,
        });
        return {
          callId,
          token,
          tokenExpiresAt: DateTime.add(startedAt, { seconds: ttlSeconds }),
          newSessionExpiresAt: DateTime.add(startedAt, {
            seconds: VOICE_CALL_NEW_SESSION_TTL_SECONDS,
          }),
          model: VOICE_CALL_MODEL,
          fallbackModel: VOICE_CALL_FALLBACK_MODEL,
          voiceName: name,
          quietHangupMinutes: settings.quietHangupMinutes,
          maxCallMinutes: VOICE_CALL_MAX_MINUTES,
          botName: chat.bot.name,
          systemInstruction,
          context: {
            botId: chat.botId,
            botName: chat.bot.name,
            botTitle: chat.bot.title,
            displayName: profile.displayName,
            botStatus: statusLabel,
            botStatusDetail: statusDetail,
            recentMessages: context,
            callouts,
          },
        } satisfies VoiceCallStartResult;
      }),
    );

  const checkKey: PersonalVoiceCallService["Service"]["checkKey"] = () =>
    Effect.gen(function* () {
      const saved = yield* sessions.sharedSecrets();
      const key = saved.find((secret) => secret.name === VOICE_CALL_SECRET_NAME);
      if (key === undefined) {
        return { status: "missing", origin: "" } satisfies VoiceCallKeyCheckResult;
      }
      if (key.mode !== "brokered" || !key.origins.includes(VOICE_CALL_SECRET_ORIGIN)) {
        return {
          status: "rejected",
          origin: key.origins[0] ?? "",
        } satisfies VoiceCallKeyCheckResult;
      }
      // One real single-use token: it proves Live access without any audio
      // being billed, which is exactly what "Checking this key" should mean.
      const status = yield* mint(key, VOICE_CALL_NEW_SESSION_TTL_SECONDS).pipe(
        Effect.map((): VoiceCallKeyCheckResult["status"] => "ok"),
        Effect.catch((error: PersonalVoiceCallsError) =>
          Effect.succeed(
            error.code === "key_quota"
              ? ("quota" as const)
              : error.code === "key_rejected"
                ? ("rejected" as const)
                : error.code === "no_key"
                  ? ("missing" as const)
                  : ("unavailable" as const),
          ),
        ),
      );
      return { status, origin: VOICE_CALL_SECRET_ORIGIN } satisfies VoiceCallKeyCheckResult;
    });

  const send: PersonalVoiceCallService["Service"]["send"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* callableChat(input.threadId);
      const text = input.text.trim();
      if (text.length === 0) {
        return yield* fail("invalid_input", "There was nothing to send.");
      }
      if (text.length > VOICE_CALL_MAX_SENT_CHARS) {
        return yield* fail("invalid_input", "That message is too long for a call.");
      }
      const createdAt = yield* DateTime.now;
      const messageId = MessageId.make(NodeCrypto.randomUUID());
      const modelSelection = yield* botModelSelectionForThread(
        bots,
        chat.threadId,
        chat.shell.modelSelection,
      );
      // No text references this record, so the provider's projection drops it;
      // the client reads it to tag the bubble "From the call".
      const context: OrchestrationMessageContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make(PERSONAL_VOICE_CALL_CONTEXT_KIND),
            label: "From the call",
            kind: PERSONAL_VOICE_CALL_CONTEXT_KIND,
            payload: { callId: input.callId, source: "voice_call" },
          },
        ],
      };
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`personal-voice-call:${input.callId}:${messageId}:turn.start`),
          threadId: chat.threadId,
          ...(modelSelection === undefined ? {} : { modelSelection }),
          message: {
            messageId,
            role: "user",
            text,
            attachments: [],
            context,
          },
          runtimeMode: chat.shell.runtimeMode,
          interactionMode: chat.shell.interactionMode,
          createdAt: DateTime.formatIso(createdAt),
        })
        .pipe(
          Effect.mapError((cause) =>
            fail("google_unavailable", "The message could not be posted to the chat.", cause),
          ),
        );
      yield* Effect.logInfo("personal voice call message posted", {
        threadId: chat.threadId,
        callId: input.callId,
        messageId,
      });
      return { messageId, createdAt } satisfies VoiceCallSendResult;
    });

  const finish: PersonalVoiceCallService["Service"]["finish"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* calls
        .get(input.callId)
        .pipe(
          Effect.mapError((cause) => fail("not_found", "Could not read the call card.", cause)),
        );
      if (Option.isSome(existing)) {
        // Idempotent: a card is written once and never rewritten.
        return { call: existing.value, alreadyStored: true } satisfies VoiceCallFinishResult;
      }
      const chat = yield* callableChat(input.threadId);
      const profile = yield* botService
        .getProfile()
        .pipe(Effect.orElseSucceed(() => ({ displayName: "", voiceCalls: undefined })));
      const durationSeconds = Math.max(
        0,
        Math.round(
          (DateTime.toEpochMillis(input.endedAt) - DateTime.toEpochMillis(input.startedAt)) / 1000,
        ),
      );
      const transcript = input.transcript
        .slice(0, VOICE_CALL_MAX_TRANSCRIPT_ENTRIES)
        .map((entry): VoiceCallTranscriptEntry => ({
          speaker: entry.speaker,
          text: entry.text.slice(0, VOICE_CALL_MAX_TRANSCRIPT_CHARS),
          at: entry.at,
        }));
      const record: VoiceCallRecord = {
        callId: input.callId,
        threadId: chat.threadId,
        botId: chat.botId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds,
        endReason: input.endReason,
        messageCount: input.sentMessageIds.length,
        voiceName: voiceName(profileVoiceCallSettings(profile)),
        model: VOICE_CALL_MODEL,
        detail: (input.detail ?? "").slice(0, VOICE_CALL_MAX_TRANSCRIPT_CHARS),
        transcript,
      };
      const written = yield* calls
        .insert({ record, createdAt: yield* DateTime.now })
        .pipe(
          Effect.mapError((cause) => fail("not_found", "Could not store the call card.", cause)),
        );
      if (!written) {
        const raced = yield* calls
          .get(input.callId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(raced)) {
          return { call: raced.value, alreadyStored: true } satisfies VoiceCallFinishResult;
        }
      }
      yield* Effect.logInfo("personal voice call card stored", {
        threadId: chat.threadId,
        callId: input.callId,
        durationSeconds,
        endReason: input.endReason,
        messages: input.sentMessageIds.length,
      });
      return { call: record, alreadyStored: false } satisfies VoiceCallFinishResult;
    });

  const list: PersonalVoiceCallService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const facts = yield* bots
        .getChatFacts({ threadId: input.threadId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(facts)) return { calls: [] } satisfies VoiceCallListResult;
      const rows = yield* calls
        .listByThread(facts.value.threadId, VOICE_CALL_LIST_LIMIT)
        .pipe(
          Effect.mapError((cause) => fail("not_found", "Could not read the call cards.", cause)),
        );
      return { calls: rows } satisfies VoiceCallListResult;
    });

  return {
    start,
    checkKey,
    send,
    finish,
    list,
  } satisfies PersonalVoiceCallService["Service"];
});

export const layer = Layer.effect(PersonalVoiceCallService, make);

export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalVoiceCallRepository.layer),
  Layer.provideMerge(PersonalSessionAccess.layerLive),
  Layer.provideMerge(PersonalSecretRepository.layer),
  Layer.provideMerge(PersonalLoginRequestRepository.layer),
  Layer.provideMerge(VoiceCallGemini.layerLive),
);
