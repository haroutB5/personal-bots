import * as NodeCrypto from "node:crypto";

import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_PUSH_DEFAULT_PREFERENCES,
  PersonalPushError,
  PersonalPushPreferences,
  PersonalPushPayload,
  PersonalPushSubscriptionId,
  type BotAvatarShape,
  type PersonalBot,
  type PersonalPushDevice,
  type PersonalPushSettings,
  type PersonalPushSubscribeInput,
  type OrchestrationEvent,
  type PersonalTask,
  type ThreadId,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  buildWebPushRequest,
  generateVapidKeyPair,
  isAllowedPushEndpoint,
  vapidKeyPairFromJwk,
  type VapidKeyPair,
  type WebPushRequest,
} from "./webPushCrypto.ts";
import { ViewingPresence } from "./viewingPresence.ts";

export const PERSONAL_PUSH_VAPID_SECRET = "personal-push-vapid";
const PREFERENCES_META_KEY = "pushPreferences";
/** Attempts per message; the delays between them. */
export const PERSONAL_PUSH_MAX_ATTEMPTS = 5;
export const PERSONAL_PUSH_BACKOFF_SECONDS = [30, 120, 600, 1_800] as const;
const MESSAGE_TTL_SECONDS = 24 * 60 * 60;
const PENDING_EXPIRY_HOURS = 24;
const RETENTION_DAYS = 7;
const SWEEP_INTERVAL = "30 seconds";
const BATCH_SIZE = 50;
const VAPID_SUBJECT =
  process.env.T3_PERSONAL_PUSH_SUBJECT?.trim() || "mailto:personal-bots@example.com";

export class PersonalPushSendError extends Schema.TaggedError<PersonalPushSendError>()(
  "PersonalPushSendError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

const sendError = (cause: unknown) =>
  new PersonalPushSendError({
    reason: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Sends one encrypted push request; returns the push service's HTTP status. */
export class PersonalPushTransport extends Context.Service<
  PersonalPushTransport,
  {
    readonly send: (
      request: WebPushRequest,
    ) => Effect.Effect<{ readonly status: number }, PersonalPushSendError>;
  }
>()("t3/personal/push/PersonalPushService/PersonalPushTransport") {}

export const transportLive = Layer.succeed(PersonalPushTransport, {
  send: (request) =>
    Effect.tryPromise({
      try: async () => {
        // @effect-diagnostics-next-line globalFetchInEffect:off - one binary POST to an allowlisted push service; no redirects, bounded timeout.
        const response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        await response.body?.cancel();
        return { status: response.status };
      },
      catch: sendError,
    }),
});

export type PersonalPushEventKind =
  | "task_completed"
  | "task_needs_input"
  | "task_failed"
  | "routine_result"
  | "chat_reply";

const PREFERENCE_FOR: Record<PersonalPushEventKind, keyof PersonalPushPreferences> = {
  task_completed: "taskCompleted",
  task_needs_input: "taskNeedsInput",
  task_failed: "taskFailed",
  routine_result: "routineResult",
  chat_reply: "chatReply",
};

/**
 * Which notification (if any) a task transition earns. Completion and
 * failure notify for top-level tasks only (delegated children report to
 * their parent); anything waiting on the user always notifies.
 */
export function pushEventForTask(task: PersonalTask): PersonalPushEventKind | null {
  switch (task.status) {
    case "waiting_for_user":
    case "waiting_for_browser":
      return "task_needs_input";
    case "completed":
      if (task.parentTaskId !== null) return null;
      return task.source === "routine" ? "routine_result" : "task_completed";
    case "failed":
      return task.parentTaskId === null ? "task_failed" : null;
    default:
      return null;
  }
}

/**
 * Who a notification is from: the bot's name, and its avatar when the bot is
 * known. `avatar` is deliberately a required field that can be null rather than
 * an optional one - a caller that could not resolve the bot has to say so, so a
 * test fixture cannot quietly carry an avatar that production would omit.
 */
export interface PushBotIdentity {
  readonly name: string;
  readonly avatar: { readonly shape: BotAvatarShape; readonly color: string } | null;
}

/** The two payload fields the service worker draws the icon from, or nothing. */
const avatarFields = (
  bot: PushBotIdentity,
): Pick<PersonalPushPayload, "avatarShape" | "avatarColor"> =>
  bot.avatar === null ? {} : { avatarShape: bot.avatar.shape, avatarColor: bot.avatar.color };

/** The bot as the notification names it when the row has gone. */
const UNKNOWN_BOT: PushBotIdentity = { name: "Your bot", avatar: null };

const botIdentity = (bot: Option.Option<PersonalBot>): PushBotIdentity =>
  Option.isSome(bot)
    ? {
        name: bot.value.name,
        avatar: { shape: bot.value.avatarShape, color: bot.value.avatarColor },
      }
    : UNKNOWN_BOT;

/** Minimal payload: bot name, task title, deep link. Never message text. */
export function pushPayloadForTask(
  kind: PersonalPushEventKind,
  task: PersonalTask,
  bot: PushBotIdentity,
): PersonalPushPayload {
  const botName = bot.name;
  const title =
    kind === "task_needs_input"
      ? task.status === "waiting_for_browser"
        ? `${botName} needs your help in the browser`
        : `${botName} needs you`
      : kind === "task_failed"
        ? `${botName} hit a problem`
        : `${botName} finished`;
  const body = task.title.length > 120 ? `${task.title.slice(0, 117)}...` : task.title;
  // Take control lives in the bot's chat, so browser help opens the chat.
  const url =
    task.status === "waiting_for_browser" && task.threadId !== null
      ? `/bots/${encodeURIComponent(task.botId)}/${encodeURIComponent(task.threadId)}`
      : `/tasks/${task.taskId}`;
  return { title, body, url, tag: `task-${task.taskId}`, ...avatarFields(bot) };
}

/**
 * A bot finished its turn in a chat. The reply itself never travels: the
 * notification says who spoke and links to the chat. One tag per thread, so a
 * second reply in the same chat replaces the first on the lock screen instead
 * of stacking.
 */
export function chatReplyPushPayload(input: {
  readonly botId: string;
  readonly bot: PushBotIdentity;
  readonly threadId: string;
}): PersonalPushPayload {
  return {
    title: `${input.bot.name} replied`,
    body: "Open the chat to read it.",
    url: `/bots/${encodeURIComponent(input.botId)}/${encodeURIComponent(input.threadId)}`,
    tag: `chat-${input.threadId}`,
    ...avatarFields(input.bot),
  };
}

/** "Claude Code 2.1.264 is failing for your bots", linking to the Settings provider row. */
export function providerBrokenPushPayload(input: {
  readonly instanceId: string;
  readonly label: string;
  readonly version: string;
}): PersonalPushPayload {
  return {
    title: `${input.label} ${input.version} is failing for your bots`,
    body: "A test message after the update failed. Open Settings to update or check again.",
    url: "/bots/settings",
    tag: `provider-${input.instanceId}`,
  };
}

const SubscriptionRow = Schema.Struct({
  subscriptionId: PersonalPushSubscriptionId,
  endpoint: Schema.String,
  deviceLabel: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  lastSuccessAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastFailureAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastError: Schema.NullOr(Schema.String),
});
const decodeSubscriptionRow = Schema.decodeUnknownEffect(SubscriptionRow);
/**
 * Preferences are read leniently and merged over the defaults: a blob stored
 * before a new event kind existed must keep the toggles it does carry rather
 * than resetting every one of them to the default.
 */
const StoredPreferences = Schema.Struct({
  taskCompleted: Schema.optional(Schema.Boolean),
  taskNeedsInput: Schema.optional(Schema.Boolean),
  taskFailed: Schema.optional(Schema.Boolean),
  routineResult: Schema.optional(Schema.Boolean),
  chatReply: Schema.optional(Schema.Boolean),
});
const decodeStoredPreferences = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredPreferences),
);
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(PersonalPushPreferences));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(PersonalPushPayload));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isPushError = Schema.is(PersonalPushError);

const vapidFromBytes = (bytes: Uint8Array) =>
  vapidKeyPairFromJwk(decodeJson(Buffer.from(bytes).toString("utf8")) as NodeCrypto.JsonWebKey);

interface OutboxDueRow {
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly payloadJson: string;
  readonly attempts: number;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

interface GroupThreadForMemberRow {
  readonly threadId: string;
}

export class PersonalPushService extends Context.Service<
  PersonalPushService,
  {
    readonly publicKey: () => Effect.Effect<string, PersonalPushError>;
    readonly getSettings: () => Effect.Effect<PersonalPushSettings, PersonalPushError>;
    readonly subscribe: (
      input: PersonalPushSubscribeInput,
    ) => Effect.Effect<PersonalPushSubscriptionId, PersonalPushError>;
    readonly unsubscribe: (input: {
      readonly endpoint: string;
    }) => Effect.Effect<void, PersonalPushError>;
    readonly test: (input: {
      readonly endpoint?: string | undefined;
    }) => Effect.Effect<number, PersonalPushError>;
    readonly setPreferences: (
      preferences: PersonalPushPreferences,
    ) => Effect.Effect<PersonalPushPreferences, PersonalPushError>;
    /** Queues the notification a task transition earns (deduped per transition). */
    readonly notifyTask: (task: PersonalTask) => Effect.Effect<void>;
    /**
     * A bot ended its turn in a chat. Notifies only when nothing more
     * specific covers it: see the guards in the implementation.
     */
    readonly notifyChatReply: (input: {
      readonly threadId: ThreadId;
      /** The session stamp the turn ended on; also the per-turn dedupe key. */
      readonly turnEndedAt: string;
    }) => Effect.Effect<void>;
    /** Feeds one orchestration event in (the start() stream uses this). */
    readonly ingestDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
    /**
     * One connection says which chat it has open and visible (null = none).
     * Notifications for that chat are held back while it is being read.
     */
    readonly reportViewing: (input: {
      readonly connectionId: string;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<void>;
    /** The connection went away: it views nothing. */
    readonly dropConnection: (connectionId: string) => Effect.Effect<void>;
    /** Queues the one "provider is failing for your bots" alert for this version. */
    readonly notifyProviderBroken: (input: {
      readonly instanceId: string;
      readonly label: string;
      readonly version: string;
    }) => Effect.Effect<void>;
    /** Queues one pass: send due messages, expire and prune old rows. */
    readonly sweep: Effect.Effect<void>;
    /** Resolves when every queued send pass has finished. */
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/personal/push/PersonalPushService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const transport = yield* PersonalPushTransport;
  const botRepository = yield* PersonalBotRepository.PersonalBotRepository;
  const tasks = yield* Effect.serviceOption(PersonalTaskService.PersonalTaskService);
  const engine = yield* Effect.serviceOption(OrchestrationEngine.OrchestrationEngineService);

  const fail = (message: string, cause?: unknown) =>
    new PersonalPushError({ message, ...(cause === undefined ? {} : { cause }) });

  const storageFailure =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersonalPushError, R> =>
      effect.pipe(
        Effect.mapError((cause) =>
          isPushError(cause) ? cause : fail(`Personal notifications ${operation} failed.`, cause),
        ),
      );

  // Generated once and kept in the server secret store; the private key never
  // leaves it and only the public half is ever sent to a client.
  let vapidCache: VapidKeyPair | null = null;
  const vapid = Effect.gen(function* () {
    if (vapidCache !== null) return vapidCache;
    const stored = yield* secrets.get(PERSONAL_PUSH_VAPID_SECRET);
    if (Option.isSome(stored)) {
      vapidCache = vapidFromBytes(stored.value);
      return vapidCache;
    }
    const generated = generateVapidKeyPair();
    const encoded = new Uint8Array(Buffer.from(encodeJson(generated.privateJwk), "utf8"));
    yield* secrets
      .create(PERSONAL_PUSH_VAPID_SECRET, encoded)
      .pipe(Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void));
    // Read back: a concurrent first use may have won the create.
    const winner = yield* secrets.get(PERSONAL_PUSH_VAPID_SECRET);
    if (Option.isNone(winner)) {
      return yield* fail("The notification key could not be stored.");
    }
    vapidCache = vapidFromBytes(winner.value);
    return vapidCache;
  });

  const readPreferences = botRepository.getMeta({ key: PREFERENCES_META_KEY }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(PERSONAL_PUSH_DEFAULT_PREFERENCES),
        onSome: (raw) =>
          decodeStoredPreferences(raw).pipe(
            Effect.map((stored): PersonalPushPreferences => {
              const merged = { ...PERSONAL_PUSH_DEFAULT_PREFERENCES };
              for (const key of Object.keys(merged) as Array<keyof PersonalPushPreferences>) {
                const value = stored[key];
                if (value !== undefined) merged[key] = value;
              }
              return merged;
            }),
            Effect.orElseSucceed(() => PERSONAL_PUSH_DEFAULT_PREFERENCES),
          ),
      }),
    ),
  );

  const listDevices = sql`
    SELECT subscription_id AS "subscriptionId", endpoint AS "endpoint",
           device_label AS "deviceLabel", created_at AS "createdAt",
           last_success_at AS "lastSuccessAt", last_failure_at AS "lastFailureAt",
           last_error AS "lastError"
    FROM personal_push_subscriptions ORDER BY created_at ASC
  `.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeSubscriptionRow(row))),
    Effect.map((rows) =>
      rows.map(({ endpoint, ...row }): PersonalPushDevice => ({
        ...row,
        endpointHost: new URL(endpoint).hostname,
      })),
    ),
  );

  /** Queues `payload` for each subscription; returns how many rows were new. */
  const enqueue = (eventId: string, payload: PersonalPushPayload, endpoint?: string) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* sql<{ readonly subscriptionId: string }>`
        INSERT INTO personal_notification_outbox (
          event_id, subscription_id, payload_json, attempts, status, next_attempt_at,
          last_error, created_at, updated_at
        )
        SELECT ${eventId}, subscription_id, ${encodePayload(payload)}, 0, 'pending',
               ${nowIso}, NULL, ${nowIso}, ${nowIso}
        FROM personal_push_subscriptions
        -- SQLite needs a WHERE on INSERT ... SELECT ... ON CONFLICT to parse it.
        WHERE ${endpoint === undefined ? sql`1 = 1` : sql`endpoint = ${endpoint}`}
        ON CONFLICT (event_id, subscription_id) DO NOTHING
        RETURNING subscription_id AS "subscriptionId"
      `;
      return inserted.length;
    });

  const sendOne = Effect.fn("PersonalPushService.sendOne")(function* (
    row: OutboxDueRow,
    keys: VapidKeyPair,
  ) {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const request = yield* Effect.try({
      try: () =>
        buildWebPushRequest({
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
          payload: row.payloadJson,
          vapid: keys,
          subject: VAPID_SUBJECT,
          nowSeconds: Math.floor(DateTime.toEpochMillis(now) / 1000),
          ttlSeconds: MESSAGE_TTL_SECONDS,
        }),
      catch: sendError,
    }).pipe(Effect.result);
    const outcome =
      request._tag === "Failure"
        ? { kind: "fatal" as const, error: request.failure.message }
        : yield* transport.send(request.success).pipe(
            Effect.map(({ status }) =>
              status >= 200 && status < 300
                ? { kind: "sent" as const }
                : status === 404 || status === 410
                  ? { kind: "gone" as const, error: `Push service answered ${status}.` }
                  : status === 429 || status >= 500
                    ? { kind: "retry" as const, error: `Push service answered ${status}.` }
                    : { kind: "fatal" as const, error: `Push service answered ${status}.` },
            ),
            Effect.catch((error) =>
              Effect.succeed({ kind: "retry" as const, error: error.message }),
            ),
          );
    switch (outcome.kind) {
      case "sent":
        yield* sql`
          UPDATE personal_notification_outbox
          SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ${nowIso}
          WHERE event_id = ${row.eventId} AND subscription_id = ${row.subscriptionId}
        `;
        yield* sql`
          UPDATE personal_push_subscriptions
          SET last_success_at = ${nowIso}, last_error = NULL, updated_at = ${nowIso}
          WHERE subscription_id = ${row.subscriptionId}
        `;
        return;
      case "gone":
        // The browser dropped the subscription: forget the device and
        // everything still queued for it.
        yield* sql`
          UPDATE personal_notification_outbox
          SET status = 'failed', last_error = ${outcome.error}, updated_at = ${nowIso}
          WHERE subscription_id = ${row.subscriptionId} AND status = 'pending'
        `;
        yield* sql`DELETE FROM personal_push_subscriptions WHERE subscription_id = ${row.subscriptionId}`;
        return;
      case "retry":
      case "fatal": {
        const attempts = row.attempts + 1;
        const backoff = PERSONAL_PUSH_BACKOFF_SECONDS[attempts - 1];
        const giveUp =
          outcome.kind === "fatal" ||
          attempts >= PERSONAL_PUSH_MAX_ATTEMPTS ||
          backoff === undefined;
        const nextAttempt = giveUp
          ? nowIso
          : DateTime.formatIso(DateTime.add(now, { seconds: backoff }));
        yield* sql`
          UPDATE personal_notification_outbox
          SET status = ${giveUp ? "failed" : "pending"}, attempts = ${attempts},
              next_attempt_at = ${nextAttempt}, last_error = ${outcome.error},
              updated_at = ${nowIso}
          WHERE event_id = ${row.eventId} AND subscription_id = ${row.subscriptionId}
        `;
        yield* sql`
          UPDATE personal_push_subscriptions
          SET last_failure_at = ${nowIso}, last_error = ${outcome.error}, updated_at = ${nowIso}
          WHERE subscription_id = ${row.subscriptionId}
        `;
        return;
      }
    }
  });

  const sweepOnce = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const expiredBefore = DateTime.formatIso(
      DateTime.subtract(now, { hours: PENDING_EXPIRY_HOURS }),
    );
    const prunedBefore = DateTime.formatIso(DateTime.subtract(now, { days: RETENTION_DAYS }));
    yield* sql`
      UPDATE personal_notification_outbox
      SET status = 'expired', updated_at = ${nowIso}
      WHERE status = 'pending' AND created_at < ${expiredBefore}
    `;
    yield* sql`
      DELETE FROM personal_notification_outbox
      WHERE status <> 'pending' AND updated_at < ${prunedBefore}
    `;
    const due = yield* sql<OutboxDueRow>`
      SELECT o.event_id AS "eventId", o.subscription_id AS "subscriptionId",
             o.payload_json AS "payloadJson", o.attempts AS "attempts",
             s.endpoint AS "endpoint", s.p256dh AS "p256dh", s.auth AS "auth"
      FROM personal_notification_outbox o
      JOIN personal_push_subscriptions s ON s.subscription_id = o.subscription_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= ${nowIso}
      ORDER BY o.created_at ASC
      LIMIT ${BATCH_SIZE}
    `;
    if (due.length === 0) return;
    const keys = yield* vapid;
    for (const row of due) {
      yield* sendOne(row, keys);
    }
  });

  const worker = yield* makeDrainableWorker(() =>
    sweepOnce.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal notifications sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const kick = worker.enqueue("sweep");

  const publicKey: PersonalPushService["Service"]["publicKey"] = () =>
    vapid.pipe(
      Effect.map((keys) => base64UrlEncode(keys.publicKey)),
      storageFailure("key"),
    );

  const getSettings: PersonalPushService["Service"]["getSettings"] = () =>
    Effect.gen(function* () {
      const [key, preferences, devices] = yield* Effect.all([vapid, readPreferences, listDevices]);
      return {
        publicKey: base64UrlEncode(key.publicKey),
        preferences,
        devices,
      } satisfies PersonalPushSettings;
    }).pipe(storageFailure("settings"));

  const subscribe: PersonalPushService["Service"]["subscribe"] = (input) =>
    Effect.gen(function* () {
      if (!isAllowedPushEndpoint(input.endpoint)) {
        return yield* fail("This is not a browser push service endpoint.");
      }
      const p256dh = base64UrlDecode(input.keys.p256dh);
      const auth = base64UrlDecode(input.keys.auth);
      if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) {
        return yield* fail("The subscription keys are malformed.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql<{ readonly subscriptionId: PersonalPushSubscriptionId }>`
        INSERT INTO personal_push_subscriptions (
          subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at
        )
        VALUES (
          ${NodeCrypto.randomUUID()}, ${input.endpoint}, ${input.keys.p256dh}, ${input.keys.auth},
          ${input.deviceLabel?.trim() ?? ""}, ${nowIso}, ${nowIso}
        )
        ON CONFLICT (endpoint) DO UPDATE SET
          p256dh = excluded.p256dh,
          auth = excluded.auth,
          device_label = excluded.device_label,
          updated_at = excluded.updated_at
        RETURNING subscription_id AS "subscriptionId"
      `;
      const subscriptionId = rows[0]?.subscriptionId;
      if (subscriptionId === undefined) {
        return yield* fail("The subscription could not be stored.");
      }
      return subscriptionId;
    }).pipe(storageFailure("subscribe"));

  const unsubscribe: PersonalPushService["Service"]["unsubscribe"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          DELETE FROM personal_notification_outbox
          WHERE subscription_id IN (
            SELECT subscription_id FROM personal_push_subscriptions WHERE endpoint = ${input.endpoint}
          )
        `;
          yield* sql`DELETE FROM personal_push_subscriptions WHERE endpoint = ${input.endpoint}`;
        }),
      )
      .pipe(storageFailure("unsubscribe"));

  const test: PersonalPushService["Service"]["test"] = (input) =>
    Effect.gen(function* () {
      const queued = yield* enqueue(
        `test:${NodeCrypto.randomUUID()}`,
        { title: "Bots", body: "Test notification", url: "/bots/settings/notifications" },
        input.endpoint,
      );
      if (queued === 0) {
        return yield* fail("No device is subscribed to notifications yet.");
      }
      yield* kick;
      return queued;
    }).pipe(storageFailure("test"));

  const setPreferences: PersonalPushService["Service"]["setPreferences"] = (preferences) =>
    botRepository
      .setMeta({ key: PREFERENCES_META_KEY, value: encodePreferences(preferences) })
      .pipe(Effect.as(preferences), storageFailure("preferences"));

  const presence = new ViewingPresence();

  const reportViewing: PersonalPushService["Service"]["reportViewing"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      presence.report(input.connectionId, input.threadId, DateTime.toEpochMillis(now));
    });

  const dropConnection: PersonalPushService["Service"]["dropConnection"] = (connectionId) =>
    Effect.sync(() => presence.drop(connectionId));

  const notifyTask: PersonalPushService["Service"]["notifyTask"] = (task) =>
    Effect.gen(function* () {
      const kind = pushEventForTask(task);
      if (kind === null) return;
      // The user is reading this chat right now: they can see it happen, so a
      // notification would only buzz the phone in their hand. Tasks with no
      // chat of their own (and provider alerts) always notify.
      if (task.threadId !== null) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (presence.isViewing(task.threadId, nowMs)) {
          yield* Effect.logDebug("personal notification held back: the chat is open", {
            taskId: task.taskId,
            threadId: task.threadId,
            kind,
          });
          return;
        }
      }
      const preferences = yield* readPreferences;
      if (!preferences[PREFERENCE_FOR[kind]]) return;
      const bot = yield* botRepository.getBotById({ botId: task.botId });
      // One event per transition: a replayed or re-published upsert dedupes.
      const eventId = `task:${task.taskId}:${task.status}:${DateTime.formatIso(task.updatedAt)}`;
      const queued = yield* enqueue(eventId, pushPayloadForTask(kind, task, botIdentity(bot)));
      if (queued > 0) yield* kick;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal notifications could not queue a task event", {
              taskId: task.taskId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * A bot ended its turn in a chat. The turn is the signal: a question asked
   * in prose is not reliably detectable, so any reply that lands while the
   * user is elsewhere notifies.
   *
   * One buzz per turn, decided by four guards in this order:
   *  1. the chat is open and visible on some connection - the user is already
   *     reading it, so nothing is queued;
   *  2. the thread is not a personal bot's - project and dev threads never
   *     notify here;
   *  3. a task attempt drives (or just drove) this turn - the task stream
   *     already earns the more specific notification for it: "needs you" when
   *     the turn parked on a secret request or browser help, "finished" or
   *     "hit a problem" when it ended. A delegation to another bot is this
   *     case too: the delegating bot's MCP call opens a caller task, so the
   *     hand-off is silent here and the user hears about it once, when the
   *     work it started is done;
   *  4. the preference is off.
   * The outbox key is thread plus the session stamp the turn ended on, so a
   * replayed event cannot buzz twice for one turn.
   */
  const notifyChatReply: PersonalPushService["Service"]["notifyChatReply"] = (input) =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (presence.isViewing(input.threadId, nowMs)) return;
      // A group displays member replies from their private provider threads in
      // its shared transcript. Treat that shared thread as the visible chat:
      // otherwise every member would still buzz the phone while the user is
      // already watching the reply arrive in the open group.
      const groupThreads = yield* sql<GroupThreadForMemberRow>`
        SELECT g.thread_id AS "threadId"
        FROM personal_group_members m
        JOIN personal_groups g ON g.group_id = m.group_id
        WHERE m.thread_id = ${input.threadId}
          AND m.left_at IS NULL
          AND g.deleted_at IS NULL
        LIMIT 1
      `;
      const visibleGroupThread = groupThreads[0]?.threadId;
      if (visibleGroupThread !== undefined && presence.isViewing(visibleGroupThread, nowMs)) {
        yield* Effect.logDebug("personal notification held back: the member's group is open", {
          threadId: input.threadId,
          groupThreadId: visibleGroupThread,
        });
        return;
      }
      const link = yield* botRepository.getThreadLink({ threadId: input.threadId });
      if (Option.isNone(link)) return;
      if (Option.isSome(tasks) && (yield* tasks.value.ownsThreadTurn(input.threadId))) {
        yield* Effect.logDebug("personal notification held back: a task owns this turn", {
          threadId: input.threadId,
        });
        return;
      }
      const preferences = yield* readPreferences;
      if (!preferences[PREFERENCE_FOR.chat_reply]) return;
      const bot = yield* botRepository.getBotById({ botId: link.value.botId });
      const eventId = `chat-reply:${input.threadId}:${input.turnEndedAt}`;
      const queued = yield* enqueue(
        eventId,
        chatReplyPushPayload({
          botId: link.value.botId,
          bot: botIdentity(bot),
          threadId: input.threadId,
        }),
      );
      if (queued > 0) yield* kick;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal notifications could not queue a chat reply", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * A turn ending is the transition running -> ready, not the "ready" state
   * itself: a session that starts or is re-attached publishes "ready" too, and
   * that is nobody replying. Only the edge is a reply.
   *
   * "interrupted" and "stopped" are the user's own doing and "error" belongs
   * to the task stream's "hit a problem", so they clear the thread without
   * notifying. Threads are remembered only between their own start and end, so
   * this set is bounded by the turns actually in flight; after a restart the
   * turn already running is not remembered, and its end is silent rather than
   * risk a notification for a turn that was never observed.
   */
  const runningThreadIds = new Set<string>();

  const ingestDomainEvent: PersonalPushService["Service"]["ingestDomainEvent"] = (event) => {
    if (event.type !== "thread.session-set") return Effect.void;
    const { threadId, session } = event.payload;
    if (session.status === "running") {
      runningThreadIds.add(threadId);
      return Effect.void;
    }
    const wasRunning = runningThreadIds.delete(threadId);
    return wasRunning && session.status === "ready"
      ? notifyChatReply({ threadId, turnEndedAt: session.updatedAt })
      : Effect.void;
  };

  // A broken provider stops every bot on it, so it rides the "hit a problem"
  // preference. One event per instance and version: a re-check that fails
  // again for the same version dedupes in the outbox.
  const notifyProviderBroken: PersonalPushService["Service"]["notifyProviderBroken"] = (input) =>
    Effect.gen(function* () {
      const preferences = yield* readPreferences;
      if (!preferences.taskFailed) return;
      const eventId = `provider-broken:${input.instanceId}:${input.version}`;
      const queued = yield* enqueue(eventId, providerBrokenPushPayload(input));
      if (queued > 0) yield* kick;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal notifications could not queue a provider alert", {
              instanceId: input.instanceId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const start: PersonalPushService["Service"]["start"] = () =>
    Effect.gen(function* () {
      if (Option.isSome(tasks)) {
        yield* forkParked(Stream.runForEach(tasks.value.changes, notifyTask));
      }
      if (Option.isSome(engine)) {
        const events = yield* engine.value.subscribeDomainEvents;
        yield* forkParked(Stream.runForEach(events, ingestDomainEvent));
      }
      yield* forkParked(
        Effect.gen(function* () {
          yield* kick;
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
      );
    });

  return {
    publicKey,
    getSettings,
    subscribe,
    unsubscribe,
    test,
    setPreferences,
    notifyTask,
    notifyChatReply,
    ingestDomainEvent,
    reportViewing,
    dropConnection,
    notifyProviderBroken,
    sweep: kick,
    drain: worker.drain,
    start,
  } satisfies PersonalPushService["Service"];
});

export const layer = Layer.effect(PersonalPushService, make);
