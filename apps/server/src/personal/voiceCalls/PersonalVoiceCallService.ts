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
  VOICE_CALL_LOOKUP_MEMORY_CHARS,
  VOICE_CALL_LOOKUP_MEMORY_MAX,
  VOICE_CALL_MAX_MINUTES,
  VOICE_CALL_MAX_SENT_CHARS,
  VOICE_CALL_MAX_TRANSCRIPT_CHARS,
  VOICE_CALL_MAX_TRANSCRIPT_ENTRIES,
  VOICE_CALL_MODEL,
  VOICE_CALL_NEW_SESSION_TTL_SECONDS,
  VOICE_CALL_SEARCHES_PER_MINUTE,
  VOICE_CALL_SEARCH_TIMEOUT_MS,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  VOICE_CALL_SNAPSHOT_REPLY_CHARS,
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
  type VoiceCallLookupMemoryResult,
  type VoiceCallMemoryEntry,
  type VoiceCallRecord,
  type VoiceCallRenewPassResult,
  type VoiceCallSearchWebResult,
  type VoiceCallSendResult,
  type VoiceCallSnapshotResult,
  type VoiceCallStartResult,
  type VoiceCallTranscriptEntry,
  type VoiceCallTranscriptResult,
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
import * as PersonalMemoryService from "../memory/PersonalMemoryService.ts";
import * as PersonalBrowser from "../browser/PersonalBrowser.ts";
import * as PersonalLoginRequestRepository from "../secrets/PersonalLoginRequestRepository.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import * as PersonalSessionAccess from "../secrets/PersonalSessionAccess.ts";
import type { SecretBrokerError } from "../secrets/secretBroker.ts";
import { personalWorkingProgress } from "../workingProgress.ts";
import { redactSecrets } from "../secretText.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";
import { createVoiceCallRateLimiter } from "./voiceCallRateLimit.ts";
import * as VoiceCallGemini from "./voiceCallGemini.ts";
import { voiceCallSystemInstruction } from "./voiceCallInstructions.ts";
import {
  layerLive as VoiceCallSearchLive,
  VOICE_SEARCH_QUOTA_META_KEY,
  VoiceCallWebSearch,
  cleanSearchQuery,
  searchQuotaStillHolds,
  shapeSearchResults,
} from "./voiceCallSearch.ts";

/** The saved key the keyless search can fall back to, when its owner added one. */
const TAVILY_SECRET_NAME = "TAVILY_API_KEY";

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
    /**
     * The **call's own** chat, as of now: status, step and newest reply, all
     * redacted and bounded here. The thread comes from the call's lease, never
     * from whatever chat the phone happens to be showing, so navigating away
     * mid-send cannot make the voice read another chat's reply or decide the
     * turn ended. A chat that has had a sensitive site open returns the status
     * alone, with no chat text.
     */
    readonly snapshot: (input: {
      readonly threadId: ThreadId;
      readonly callId: string;
    }) => Effect.Effect<VoiceCallSnapshotResult, PersonalVoiceCallsError>;
    /** One card's stored transcript, read only when the owner expands it. */
    readonly transcript: (input: {
      readonly callId: string;
    }) => Effect.Effect<VoiceCallTranscriptResult, PersonalVoiceCallsError>;
    /**
     * The voice's own fast facts, without waking the real bot: up to 8 short
     * entries from the same search `search_memory` runs for that bot (shared,
     * its team and its own). Memory already refuses secrets, so no value can
     * come back; a chat with a sensitive site open gets nothing at all.
     */
    readonly lookupMemory: (input: {
      readonly threadId: ThreadId;
      readonly callId: string;
      readonly query: string;
    }) => Effect.Effect<VoiceCallLookupMemoryResult, PersonalVoiceCallsError>;
    /**
     * A fresh single-use pass for a call that is already open, after Google's
     * own Search ran out of quota. The server remembers that (until the next
     * midnight Pacific) so later calls start without it. Once per call.
     */
    readonly renewPass: (input: {
      readonly threadId: ThreadId;
      readonly callId: string;
      readonly reason: "search_quota";
    }) => Effect.Effect<VoiceCallRenewPassResult, PersonalVoiceCallsError>;
    /**
     * The voice's `search_web`: a few short results from the same keyless web
     * search the bots use, for a call that has no Google Search. Always
     * answers: a refusal or a failure comes back as an empty list and a note.
     */
    readonly searchWeb: (input: {
      readonly threadId: ThreadId;
      readonly callId: string;
      readonly query: string;
    }) => Effect.Effect<VoiceCallSearchWebResult, PersonalVoiceCallsError>;
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
  const memory = yield* PersonalMemoryService.PersonalMemoryService;
  const browser = yield* PersonalBrowser.PersonalBrowser;
  const http = yield* VoiceCallGemini.VoiceCallHttp;
  const webSearch = yield* VoiceCallWebSearch;
  const sql = yield* SqlClient.SqlClient;

  const startLimiter = createVoiceCallRateLimiter({
    limit: VOICE_CALL_STARTS_PER_MINUTE,
    windowMs: VOICE_CALL_START_WINDOW_MS,
  });
  // One start at a time: two taps must not mint two tokens and two call ids
  // for the one call the owner thinks he made.
  const startLock = yield* Semaphore.make(1);

  /**
   * The calls this process has open, `callId` -> the chat it was minted for.
   * `send`, `lookupMemory` and `snapshot` are answered from here, so a stale
   * tab (or a second chat on screen) can never post into, or read, a chat the
   * call does not belong to. The map is deliberately in memory: a call is a
   * live session, and a server restart ends it. `finish` does not consult it,
   * so a card is still stored after a restart.
   *
   * The same call is also written to `personal_voice_call_leases`, because the
   * release waiter and the nightly Updates pipeline read the database from
   * their own process: the row, not this map, is what stops a landing from
   * restarting the app mid-call.
   */
  const activeCalls = new Map<
    string,
    { readonly threadId: ThreadId; readonly expiresAtMs: number }
  >();
  /** How long past the call cap a lease is kept, for the last flush to land. */
  const ACTIVE_CALL_SLACK_MS = 5 * 60_000;
  /** The call cap plus the slack: how long a call counts as open at most. */
  const LEASE_SECONDS = VOICE_CALL_MAX_MINUTES * 60 + ACTIVE_CALL_SLACK_MS / 1000;
  /** When a call minted now stops counting as open, in memory and in the row. */
  const leaseExpiresAtMs = (startedAtMs: number): number => startedAtMs + LEASE_SECONDS * 1000;

  /**
   * A restart ends every call, so the rows a previous process left behind are
   * cleared as this one comes up. Without that, a lease whose phone died would
   * hold the release waiter (up to the call cap) after the very restart that
   * ended it.
   */
  yield* calls.clearLeases().pipe(
    Effect.tap((removed) =>
      removed === 0
        ? Effect.void
        : Effect.logInfo("personal voice call leases cleared at boot", { removed }),
    ),
    // A database that is behind this server must not stop it from starting:
    // the rows are a restart-gate hint, never a reason to refuse a boot.
    Effect.catch((cause) =>
      Effect.logWarning("personal voice call leases were not cleared at boot", { cause }),
    ),
  );

  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

  /**
   * Calls that got their one fresh pass (Google Search out of quota). Read by
   * `renewPass` to refuse a second one, and by `finish`: a renewed call that
   * still failed on quota proves the voice model itself is out, not Search, so
   * the Search memory is dropped again.
   */
  const renewedCalls = new Set<string>();
  /** One search limiter per open call, dropped with the call's lease. */
  const searchLimiters = new Map<string, ReturnType<typeof createVoiceCallRateLimiter>>();

  /** When Google Search was last seen out of quota (ISO), or null. */
  const readSearchQuotaAt = sql<{ readonly value: string }>`
    SELECT value AS "value" FROM personal_meta WHERE key = ${VOICE_SEARCH_QUOTA_META_KEY}
  `.pipe(
    Effect.map((rows) => rows[0]?.value ?? null),
    Effect.orElseSucceed(() => null as string | null),
  );

  const writeSearchQuotaAt = (iso: string) =>
    sql`
      INSERT INTO personal_meta (key, value)
      VALUES (${VOICE_SEARCH_QUOTA_META_KEY}, ${iso})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `.pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("personal voice call search quota was not remembered", { cause }),
      ),
    );

  const clearSearchQuota = sql`
    DELETE FROM personal_meta WHERE key = ${VOICE_SEARCH_QUOTA_META_KEY}
  `.pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      Effect.logWarning("personal voice call search quota was not cleared", { cause }),
    ),
  );

  /** True while the remembered "Search is out of quota" still holds. */
  const googleSearchAvailable = Effect.gen(function* () {
    const notedAt = yield* readSearchQuotaAt;
    return !searchQuotaStillHolds(notedAt, yield* nowMs);
  });

  const pruneActiveCalls = (atMs: number): void => {
    for (const [callId, lease] of activeCalls) {
      if (lease.expiresAtMs > atMs) continue;
      activeCalls.delete(callId);
      // A call that expired without `finish` leaves nothing behind.
      renewedCalls.delete(callId);
      searchLimiters.delete(callId);
    }
  };

  /** The call must be one this process minted, for this very chat. */
  const requireCall = (callId: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const atMs = yield* nowMs;
      pruneActiveCalls(atMs);
      const lease = activeCalls.get(callId);
      if (lease === undefined) {
        return yield* fail("not_found", "This call is not open any more. Start a new one.");
      }
      if (lease.threadId !== threadId) {
        return yield* fail("not_found", "That call belongs to another chat.");
      }
    });

  /**
   * A chat that has had a site the owner marked sensitive open sends nothing
   * to Google and reads nothing out: the call fails closed rather than pushing
   * the private things on that page through a voice session.
   *
   * An unreadable answer counts as exposed: a failed read must never let this
   * chat's text reach Google, so every caller refuses exactly as it does for a
   * real sensitive site. The real read's error channel is `never` (its failures
   * arrive as defects), so this catches the whole cause: `orElseSucceed` would
   * have recovered nothing and let the defect through.
   */
  const sensitiveExposure = (threadId: ThreadId) =>
    browser
      .sensitiveExposure(threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(["unreadable"] as ReadonlyArray<string>)));

  const refuseSensitiveChat = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const exposed = yield* sensitiveExposure(threadId);
      if (exposed.length > 0) {
        return yield* fail(
          "sensitive_chat",
          "This chat has had a site you marked sensitive open, so it cannot be read out on a call. Use the chat itself, or a new chat.",
        );
      }
    });

  /** The chat's own facts, or a refusal naming the reason. */
  const chatFacts = (rawThreadId: ThreadId) =>
    Effect.gen(function* () {
      const facts = yield* bots
        .getChatFacts({ threadId: rawThreadId })
        .pipe(Effect.mapError((cause) => fail("not_found", "Could not read that chat.", cause)));
      if (Option.isNone(facts)) {
        return yield* fail("not_owner_chat", "That chat cannot take a call.");
      }
      return facts.value;
    });

  /**
   * The chat must be one the owner is in on his own: a bot chat with the
   * switch on, not archived, not deleted, not a group relay, not a chat made
   * for a task or a routine. Every refusal names the reason the call screen
   * needs.
   */
  const callableChat = (rawThreadId: ThreadId) =>
    Effect.gen(function* () {
      const chat = yield* chatFacts(rawThreadId);
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
   * A chat a finished call can still be filed against: it is still the owner's
   * own bot chat, whatever happened to it during the call. A chat archived, or
   * whose bot had its switch turned off, mid-call still gets its card; the
   * alternative is losing the transcript of a call that really happened.
   */
  const storableChat = (rawThreadId: ThreadId) =>
    Effect.gen(function* () {
      const chat = yield* chatFacts(rawThreadId);
      if (chat.deleted || chat.groupRelay || chat.taskChat || chat.routineChat) {
        return yield* fail("not_owner_chat", "That chat cannot take a call.");
      }
      const bot = yield* bots
        .getBotById({ botId: chat.botId })
        .pipe(Effect.mapError((cause) => fail("not_found", "Could not read that bot.", cause)));
      if (Option.isNone(bot)) {
        return yield* fail("not_owner_chat", "That chat cannot take a call.");
      }
      return { bot: bot.value, botId: bot.value.botId, threadId: chat.threadId };
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
            ? "The Gemini voice model is out of quota for this key. Try again later."
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
            // A key the owner pasted into a message must not reach Google: the
            // same strict redaction memory applies, applied on the way out.
            text: redactSecrets(row.text),
            at: DateTime.makeUnsafe(row.at),
          }))
          .reverse(),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<VoiceCallContextMessage>),
    );

  /**
   * The bot's unfinished tasks, titles only, newest first. A title is
   * something the owner or the app wrote on one line, so it is safe to say
   * out loud; a brief, a result or a step is not and never comes from here.
   */
  const runningTaskTitles = (botId: PersonalBot["botId"]) =>
    sql<{ readonly title: string }>`
      SELECT title AS "title" FROM personal_tasks
      WHERE bot_id = ${botId}
        AND status IN (
          'queued', 'running', 'waiting_for_agent', 'waiting_for_user',
          'waiting_for_browser', 'rate_limited'
        )
        AND length(trim(title)) > 0
      ORDER BY created_at DESC
      LIMIT 5
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.title)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );

  const voiceName = (settings: { readonly voiceName: string }): string =>
    isVoiceCallVoice(settings.voiceName) ? settings.voiceName : VOICE_CALL_DEFAULT_VOICE;

  /** True while the bot's own turn is running (starting counts: it is coming). */
  const turnRunning = (shell: CallableChat["shell"]): boolean =>
    shell.session?.status === "running" || shell.session?.status === "starting";

  const statusOf = (shell: CallableChat["shell"]): string =>
    shell.hasPendingApprovals || shell.hasPendingUserInput
      ? "Waiting on you"
      : turnRunning(shell)
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
        // A chat that had the bank open is refused before a single token is
        // minted: nothing private ever reaches Google through a call.
        yield* refuseSensitiveChat(chat.threadId);
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
        const callouts = (yield* calloutLines(chat.threadId)).map((line) => redactSecrets(line));
        const taskTitles = (yield* runningTaskTitles(chat.botId)).map((title) =>
          redactSecrets(title),
        );
        // The bot's own personality and the owner's standing rules for it. Both
        // are read-only: a call must not consume the real bot's next-turn
        // preference list.
        const preferences = yield* memory.preferencesForBot({ botId: chat.botId }).pipe(
          Effect.map((entries) => entries.map((entry) => redactSecrets(entry.content))),
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        );
        const statusLabel = statusOf(chat.shell);
        const statusDetail = redactSecrets(notes[0]?.note ?? "");
        const name = voiceName(settings);
        const startedAt = yield* DateTime.now;
        const startedAtMs = DateTime.toEpochMillis(startedAt);
        const callId = NodeCrypto.randomUUID();
        pruneActiveCalls(startedAtMs);
        activeCalls.set(callId, {
          threadId: chat.threadId,
          expiresAtMs: leaseExpiresAtMs(startedAtMs),
        });
        const expiresAt = DateTime.add(startedAt, { seconds: LEASE_SECONDS });
        // The row the restart gates read. Losing it would only mean a landing
        // does not wait for this call, which is not a reason to refuse a call
        // the owner asked for, so a failure is logged and the call goes on.
        yield* calls.pruneLeases(startedAt).pipe(
          Effect.flatMap(() =>
            calls.openLease({
              callId,
              threadId: chat.threadId,
              botId: chat.botId,
              openedAt: startedAt,
              expiresAt,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning(
              "personal voice call lease not recorded; a restart gate may not see this call",
              { threadId: chat.threadId, callId, cause },
            ),
          ),
        );
        const googleSearch = yield* googleSearchAvailable;
        const systemInstruction = voiceCallSystemInstruction({
          botName: chat.bot.name,
          botTitle: chat.bot.title,
          botDescription: chat.bot.description,
          botInstructions: chat.bot.instructions,
          preferences,
          displayName: profile.displayName,
          languages: settings.languages,
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
          googleSearch,
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
          googleSearch,
          context: {
            botId: chat.botId,
            botName: chat.bot.name,
            botTitle: chat.bot.title,
            displayName: profile.displayName,
            botStatus: statusLabel,
            botStatusDetail: statusDetail,
            runningTaskTitles: taskTitles,
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
      // The call must be this process's, for this very chat, and the chat must
      // still be one that may reach Google at all.
      yield* requireCall(input.callId, chat.threadId);
      yield* refuseSensitiveChat(chat.threadId);
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
      // The answer is only ever "sent" once the chat has really taken the
      // message: the dispatch is awaited here and a refusal comes back as a
      // typed `send_failed`, so the voice is never told a lie it can repeat.
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
            fail("send_failed", "The message could not be posted to the chat.", cause),
          ),
        );
      yield* Effect.logInfo("personal voice call message posted", {
        threadId: chat.threadId,
        callId: input.callId,
        messageId,
      });
      return { messageId, createdAt } satisfies VoiceCallSendResult;
    });

  /**
   * The call is over: its lease goes with it, in memory and in the row the
   * restart gates read, so a stale phone tab cannot keep posting with this
   * call id and a landing is free to proceed. Idempotent: a retried `finish`
   * deletes a row that is already gone.
   */
  const releaseCallLease = (callId: string) =>
    Effect.gen(function* () {
      activeCalls.delete(callId);
      renewedCalls.delete(callId);
      searchLimiters.delete(callId);
      yield* calls
        .closeLease(callId)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("personal voice call lease was not closed", { callId, cause }),
          ),
        );
    });

  const finish: PersonalVoiceCallService["Service"]["finish"] = (input) =>
    Effect.gen(function* () {
      // A call that was renewed without Search and still died on quota: the
      // voice model is what ran out, so Search was not proven to be the cause.
      if (
        renewedCalls.has(input.callId) &&
        input.endReason === "failed" &&
        /quota/i.test(input.detail ?? "")
      ) {
        yield* clearSearchQuota;
      }
      const existing = yield* calls
        .get(input.callId)
        .pipe(
          Effect.mapError((cause) => fail("not_found", "Could not read the call card.", cause)),
        );
      if (Option.isSome(existing)) {
        // Idempotent: a card is written once and never rewritten.
        yield* releaseCallLease(input.callId);
        return { call: existing.value, alreadyStored: true } satisfies VoiceCallFinishResult;
      }
      // A chat archived, or whose bot had its switch turned off, mid-call still
      // gets its card: the call really happened, and the transcript is the only
      // place it survives. Only a chat that is not the owner's at all is refused.
      const chat = yield* storableChat(input.threadId);
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
          yield* releaseCallLease(input.callId);
          return { call: raced.value, alreadyStored: true } satisfies VoiceCallFinishResult;
        }
      }
      yield* releaseCallLease(input.callId);
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
      // A bot that cannot take calls has no cards to show, and the query is
      // skipped outright: the chat screen asks on every open, voice or not.
      const bot = yield* bots
        .getBotById({ botId: facts.value.botId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(bot) || !botAllowsVoiceCalls(bot.value)) {
        return { calls: [] } satisfies VoiceCallListResult;
      }
      const rows = yield* calls
        .listByThread(facts.value.threadId, VOICE_CALL_LIST_LIMIT)
        .pipe(
          Effect.mapError((cause) => fail("not_found", "Could not read the call cards.", cause)),
        );
      return { calls: rows } satisfies VoiceCallListResult;
    });

  const transcript: PersonalVoiceCallService["Service"]["transcript"] = (input) =>
    Effect.gen(function* () {
      const stored = yield* calls
        .getTranscript(input.callId)
        .pipe(
          Effect.mapError((cause) => fail("not_found", "Could not read the transcript.", cause)),
        );
      if (Option.isNone(stored)) {
        return yield* fail("not_found", "That call is not here any more.");
      }
      return {
        callId: input.callId,
        transcript: stored.value,
      } satisfies VoiceCallTranscriptResult;
    });

  /** The newest finished reply in the chat, already redacted and bounded. */
  const latestReply = (threadId: ThreadId) =>
    sql<{ readonly messageId: string; readonly text: string; readonly at: string }>`
      SELECT message_id AS "messageId", text AS "text", created_at AS "at"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'assistant'
        AND is_streaming = 0
        AND length(trim(text)) > 0
      ORDER BY created_at DESC, message_id DESC
      LIMIT 5
    `.pipe(
      Effect.map((rows) => rows.find((row) => !isServerOnlyNotice(row.text))),
      Effect.map((row) =>
        row === undefined
          ? null
          : {
              messageId: row.messageId,
              text: redactSecrets(row.text).slice(0, VOICE_CALL_SNAPSHOT_REPLY_CHARS),
              at: DateTime.makeUnsafe(row.at),
            },
      ),
      Effect.orElseSucceed(() => null),
    );

  const snapshot: PersonalVoiceCallService["Service"]["snapshot"] = (input) =>
    Effect.gen(function* () {
      // The call's own chat wins over whatever the phone is showing. A live
      // call asked about another chat is a client bug, refused rather than
      // answered with the wrong chat's words.
      const atMs = yield* nowMs;
      pruneActiveCalls(atMs);
      // The call must be one this process minted, for this very chat. Without
      // the lease a restart would leave the phone polling with a call id the
      // server no longer knows, and the old fallback answered it by reading
      // whatever chat the client named.
      const lease = activeCalls.get(input.callId);
      if (lease === undefined) {
        return yield* fail("not_found", "That call is not open any more.");
      }
      if (lease.threadId !== input.threadId) {
        return yield* fail("not_found", "That call belongs to another chat.");
      }
      const threadId = lease.threadId;
      const facts = yield* bots
        .getChatFacts({ threadId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(facts)) {
        return yield* fail("not_found", "That chat is not here any more.");
      }
      const shell = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const exposed = yield* sensitiveExposure(threadId);
      const privateChat = exposed.length > 0;
      const base = {
        status: Option.isSome(shell) ? statusOf(shell.value) : "Idle",
        turnRunning: Option.isSome(shell) ? turnRunning(shell.value) : false,
      };
      if (privateChat) {
        // Status and turn state are the app's own words, but every line of the
        // chat stays on the laptop: this chat must not be read out.
        return {
          ...base,
          stepNote: "",
          latestReply: "",
          latestReplyMessageId: "",
          latestReplyAt: null,
        } satisfies VoiceCallSnapshotResult;
      }
      const notes = yield* personalWorkingProgress(sql, [threadId]).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly note: string }>),
      );
      const reply = yield* latestReply(threadId);
      return {
        ...base,
        stepNote: redactSecrets(notes[0]?.note ?? "").slice(0, 400),
        latestReply: reply?.text ?? "",
        latestReplyMessageId: reply?.messageId ?? "",
        latestReplyAt: reply?.at ?? null,
      } satisfies VoiceCallSnapshotResult;
    });

  const lookupMemory: PersonalVoiceCallService["Service"]["lookupMemory"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* callableChat(input.threadId);
      yield* requireCall(input.callId, chat.threadId);
      const query = input.query.trim();
      if (query.length === 0) {
        return {
          entries: [],
          note: "No question to look up.",
        } satisfies VoiceCallLookupMemoryResult;
      }
      // A chat that has had a site the owner marked sensitive open sends
      // nothing to Google from here: memory text can carry what was on it.
      const exposed = yield* sensitiveExposure(chat.threadId);
      if (exposed.length > 0) {
        return {
          entries: [],
          note: "This chat has had a site the owner marked sensitive open, so nothing can be read out here.",
        } satisfies VoiceCallLookupMemoryResult;
      }
      const found = yield* memory
        .search({ query, botId: chat.botId, limit: VOICE_CALL_LOOKUP_MEMORY_MAX })
        .pipe(Effect.orElseSucceed(() => []));
      const entries: Array<VoiceCallMemoryEntry> = found
        .slice(0, VOICE_CALL_LOOKUP_MEMORY_MAX)
        .map((entry) => ({
          kind: String(entry.kind),
          // The voice reads these aloud, and they leave the laptop for Google:
          // the same redaction every other Google-bound string goes through.
          content: redactSecrets(entry.content).slice(0, VOICE_CALL_LOOKUP_MEMORY_CHARS),
        }));
      yield* Effect.logInfo("personal voice call memory lookup", {
        threadId: chat.threadId,
        callId: input.callId,
        entries: entries.length,
      });
      return {
        entries,
        note:
          entries.length === 0
            ? "Nothing saved about that. Say you do not have it saved and ask them."
            : "",
      } satisfies VoiceCallLookupMemoryResult;
    });

  const renewPass: PersonalVoiceCallService["Service"]["renewPass"] = (input) =>
    startLock.withPermit(
      Effect.gen(function* () {
        const chat = yield* callableChat(input.threadId);
        yield* requireCall(input.callId, chat.threadId);
        yield* refuseSensitiveChat(chat.threadId);
        if (renewedCalls.has(input.callId)) {
          return yield* fail("rate_limited", "This call already has a fresh pass.");
        }
        const saved = yield* sessions.secretsForThread(chat.threadId);
        const key = yield* requireKey(saved);
        // Marked before the mint: one retry per call, whatever Google answers.
        renewedCalls.add(input.callId);
        const startedAt = yield* DateTime.now;
        const ttlSeconds = Math.max(VOICE_CALL_TOKEN_TTL_SECONDS, VOICE_CALL_MAX_MINUTES * 60);
        const token = yield* mint(key, ttlSeconds);
        // Google closed the session with a quota error after a setup that had
        // Search in it: remember that until its daily reset, so the next call
        // does not spend a second connection finding out. Written only once the
        // fresh pass exists, so a failed mint does not mark Search as out.
        yield* writeSearchQuotaAt(DateTime.formatIso(startedAt));
        yield* Effect.logInfo("personal voice call pass renewed without Google Search", {
          threadId: chat.threadId,
          callId: input.callId,
          reason: input.reason,
        });
        return {
          token,
          tokenExpiresAt: DateTime.add(startedAt, { seconds: ttlSeconds }),
          newSessionExpiresAt: DateTime.add(startedAt, {
            seconds: VOICE_CALL_NEW_SESSION_TTL_SECONDS,
          }),
          googleSearch: false,
        } satisfies VoiceCallRenewPassResult;
      }),
    );

  const searchNote = (note: string): VoiceCallSearchWebResult => ({ results: [], note });

  const searchWeb: PersonalVoiceCallService["Service"]["searchWeb"] = (input) =>
    Effect.gen(function* () {
      const chat = yield* callableChat(input.threadId);
      yield* requireCall(input.callId, chat.threadId);
      const query = cleanSearchQuery(redactSecrets(input.query));
      if (query.length === 0) return searchNote("No question to search for.");
      // The same rule the bots' research tools follow: a chat that has had a
      // site the owner marked sensitive open sends nothing to a search provider.
      const exposed = yield* sensitiveExposure(chat.threadId);
      if (exposed.length > 0) {
        return searchNote(
          "This chat has had a site the owner marked sensitive open, so nothing can be searched here.",
        );
      }
      let limiter = searchLimiters.get(input.callId);
      if (limiter === undefined) {
        limiter = createVoiceCallRateLimiter({
          limit: VOICE_CALL_SEARCHES_PER_MINUTE,
          windowMs: VOICE_CALL_START_WINDOW_MS,
        });
        searchLimiters.set(input.callId, limiter);
      }
      if (!limiter.take(yield* nowMs)) {
        return searchNote("Too many searches just now. Say you will look again in a moment.");
      }
      const saved = yield* sessions.secretsForThread(chat.threadId);
      const key = saved.find((entry) => entry.name === TAVILY_SECRET_NAME)?.value || undefined;
      if (key === undefined && webSearch.providerMode() === "tavily") {
        return searchNote("Web search is not set up on this laptop.");
      }
      const answer = yield* Effect.tryPromise({
        // The signal is the fiber's, and the deadline is the voice's: a search
        // slower than this is worth less than saying "I could not find it".
        try: (signal) =>
          webSearch.search({
            scope: chat.botId,
            key,
            query,
            signal: AbortSignal.any([signal, AbortSignal.timeout(VOICE_CALL_SEARCH_TIMEOUT_MS)]),
          }),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      if (answer === null || answer.error !== null) {
        return searchNote("The search did not come back in time. Say you could not find it.");
      }
      const results = shapeSearchResults(answer.sources);
      yield* Effect.logInfo("personal voice call web search", {
        threadId: chat.threadId,
        callId: input.callId,
        results: results.length,
      });
      return results.length === 0
        ? searchNote("Nothing found for that. Say you could not find it.")
        : ({ results, note: "" } satisfies VoiceCallSearchWebResult);
    });

  return {
    start,
    checkKey,
    send,
    finish,
    list,
    snapshot,
    transcript,
    lookupMemory,
    renewPass,
    searchWeb,
  } satisfies PersonalVoiceCallService["Service"];
});

export const layer = Layer.effect(PersonalVoiceCallService, make);

export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalVoiceCallRepository.layer),
  Layer.provideMerge(PersonalSessionAccess.layerLive),
  Layer.provideMerge(PersonalSecretRepository.layer),
  Layer.provideMerge(PersonalLoginRequestRepository.layer),
  Layer.provideMerge(VoiceCallGemini.layerLive),
  Layer.provideMerge(VoiceCallSearchLive),
);
