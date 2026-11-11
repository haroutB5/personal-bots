import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BotAvatarColor, BotAvatarShape } from "./personalBots.ts";

export const PersonalPushSubscriptionId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalPushSubscriptionId"),
);
export type PersonalPushSubscriptionId = typeof PersonalPushSubscriptionId.Type;

/** Which events notify. All default to on. */
export const PersonalPushPreferences = Schema.Struct({
  taskCompleted: Schema.Boolean,
  taskNeedsInput: Schema.Boolean,
  taskFailed: Schema.Boolean,
  routineResult: Schema.Boolean,
  /**
   * A bot finished its turn in a chat with no task behind it. A question
   * asked in prose cannot be detected reliably, so the end of the turn is
   * the signal: any reply that lands while the chat is not being read.
   */
  chatReply: Schema.Boolean,
});
export type PersonalPushPreferences = typeof PersonalPushPreferences.Type;

export const PERSONAL_PUSH_DEFAULT_PREFERENCES: PersonalPushPreferences = {
  taskCompleted: true,
  taskNeedsInput: true,
  taskFailed: true,
  routineResult: true,
  chatReply: true,
};

export const PersonalPushDevice = Schema.Struct({
  subscriptionId: PersonalPushSubscriptionId,
  deviceLabel: Schema.String,
  /** Push service host only; the endpoint itself is a capability URL. */
  endpointHost: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  lastSuccessAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastFailureAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastError: Schema.NullOr(Schema.String),
});
export type PersonalPushDevice = typeof PersonalPushDevice.Type;

export const PersonalPushPublicKeyResult = Schema.Struct({
  /** VAPID public key, uncompressed P-256 point, base64url. */
  publicKey: Schema.String,
});
export type PersonalPushPublicKeyResult = typeof PersonalPushPublicKeyResult.Type;

export const PersonalPushSettings = Schema.Struct({
  publicKey: Schema.String,
  preferences: PersonalPushPreferences,
  devices: Schema.Array(PersonalPushDevice),
});
export type PersonalPushSettings = typeof PersonalPushSettings.Type;

export const PersonalPushSubscribeInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  keys: Schema.Struct({
    p256dh: TrimmedNonEmptyString,
    auth: TrimmedNonEmptyString,
  }),
  deviceLabel: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
});
export type PersonalPushSubscribeInput = typeof PersonalPushSubscribeInput.Type;

export const PersonalPushSubscribeResult = Schema.Struct({
  subscriptionId: PersonalPushSubscriptionId,
});
export type PersonalPushSubscribeResult = typeof PersonalPushSubscribeResult.Type;

export const PersonalPushEndpointInput = Schema.Struct({ endpoint: TrimmedNonEmptyString });
export type PersonalPushEndpointInput = typeof PersonalPushEndpointInput.Type;

export const PersonalPushTestInput = Schema.Struct({
  /** One device; omitted = every device. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalPushTestInput = typeof PersonalPushTestInput.Type;

export const PersonalPushTestResult = Schema.Struct({ queued: Schema.Number });
export type PersonalPushTestResult = typeof PersonalPushTestResult.Type;

/**
 * Which chat this connection has open and visible right now; null = none.
 * A notification about that chat goes to this connection first, and only
 * turns into a web push if the page does not confirm it is on screen (iOS
 * can lock without telling the page). Sent on open, visibility change and as
 * a heartbeat; entries expire.
 */
export const PersonalPushViewingInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});
export type PersonalPushViewingInput = typeof PersonalPushViewingInput.Type;

/**
 * Whether this connection's app is on screen right now. Sent on visibility
 * changes and as a heartbeat while visible. While a connection is in front
 * and listening (personalPush.inApp), notifications arrive over the socket as
 * in-app banners instead of web push: on iOS a home-screen app in the
 * foreground gets no usable notification tap.
 */
export const PersonalPushForegroundInput = Schema.Struct({
  foreground: Schema.Boolean,
});
export type PersonalPushForegroundInput = typeof PersonalPushForegroundInput.Type;

/**
 * One in-app notification: the web push payload plus an id to acknowledge it
 * by, and (chat replies only) a short preview. The preview travels only over
 * the app's own socket, never to a push service.
 */
export const PersonalPushInAppNotification = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  preview: Schema.optional(Schema.String),
  /**
   * The screen that already shows what this is about (the chat it came from).
   * A page on that screen confirms the notification without a banner.
   */
  quietPath: Schema.optional(Schema.String),
  avatarShape: Schema.optional(BotAvatarShape),
  avatarColor: Schema.optional(BotAvatarColor),
});
export type PersonalPushInAppNotification = typeof PersonalPushInAppNotification.Type;

/** The page showed (or deliberately skipped) an in-app notification. */
export const PersonalPushInAppAckInput = Schema.Struct({ id: Schema.String });
export type PersonalPushInAppAckInput = typeof PersonalPushInAppAckInput.Type;

/**
 * Phone push (Android, FCM). The phone registers the token Firebase gave it
 * and the server answers whether it can send to it: `disabled` means the
 * server holds no usable Firebase service account (secret
 * HBOTS_FCM_SERVICE_ACCOUNT), so the token is kept but nothing is sent.
 */
export const PersonalPushFcmDelivery = Schema.Literals(["ready", "disabled"]);
export type PersonalPushFcmDelivery = typeof PersonalPushFcmDelivery.Type;

export const PersonalPushFcmRegisterInput = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  appVersion: Schema.String.check(Schema.isMaxLength(40)),
});
export type PersonalPushFcmRegisterInput = typeof PersonalPushFcmRegisterInput.Type;

export const PersonalPushFcmRegisterResult = Schema.Struct({ delivery: PersonalPushFcmDelivery });
export type PersonalPushFcmRegisterResult = typeof PersonalPushFcmRegisterResult.Type;

export const PersonalPushFcmUnregisterInput = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type PersonalPushFcmUnregisterInput = typeof PersonalPushFcmUnregisterInput.Type;

/**
 * What a phone push is about. The first four are a bot waiting on the owner
 * (the request kind), the rest are information only.
 */
export const PhonePushKind = Schema.Literals([
  "question",
  "approval",
  "sign-in",
  "secret",
  "chat-reply",
  "failure",
  "task",
  "test",
]);
export type PhonePushKind = typeof PhonePushKind.Type;

/** A string because FCM data values must be strings. */
export const PHONE_PUSH_DATA_VERSION = "1";

/**
 * The FCM data message, data-only and high priority. It never carries text:
 * the phone fetches the content with `notificationId` over authenticated
 * HTTP (or the notificationContent RPC).
 */
export const PhonePushData = Schema.Struct({
  kind: PhonePushKind,
  notificationId: Schema.String,
  botId: Schema.String,
  threadId: Schema.String,
  v: Schema.Literal(PHONE_PUSH_DATA_VERSION),
});
export type PhonePushData = typeof PhonePushData.Type;

export const PersonalNotificationContentInput = Schema.Struct({
  notificationId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type PersonalNotificationContentInput = typeof PersonalNotificationContentInput.Type;

/**
 * The question a notification is waiting on, while it is still pending.
 * `inlineOptions` is the server's decision that the question may be answered
 * from the notification: the labels to offer, or null when the app must open.
 */
export const PersonalNotificationQuestion = Schema.Struct({
  requestId: Schema.String,
  question: Schema.String,
  inlineOptions: Schema.NullOr(Schema.Array(Schema.String)),
});
export type PersonalNotificationQuestion = typeof PersonalNotificationQuestion.Type;

export const PersonalNotificationContent = Schema.Struct({
  notificationId: Schema.String,
  kind: PhonePushKind,
  botId: Schema.String,
  threadId: Schema.String,
  text: Schema.NullOr(Schema.String),
  question: Schema.NullOr(PersonalNotificationQuestion),
});
export type PersonalNotificationContent = typeof PersonalNotificationContent.Type;

const NotificationCommandId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const PersonalNotificationReplyInput = Schema.Struct({
  commandId: NotificationCommandId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
});
export type PersonalNotificationReplyInput = typeof PersonalNotificationReplyInput.Type;

export const PersonalNotificationAnswerInput = Schema.Struct({
  commandId: NotificationCommandId,
  choice: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type PersonalNotificationAnswerInput = typeof PersonalNotificationAnswerInput.Type;

export const PersonalNotificationActionResult = Schema.Struct({ ok: Schema.Literal(true) });
export type PersonalNotificationActionResult = typeof PersonalNotificationActionResult.Type;

/** What a notification carries: never message text, only a title and a deep link. */
export const PersonalPushPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  tag: Schema.optional(Schema.String),
  /**
   * The sending bot's avatar, which the service worker draws into the
   * notification icon. A shape name and a hex colour only: the same two fields
   * the chats list already renders, and nothing that can carry content.
   *
   * Optional because not every notification has a bot behind it (the provider
   * alert and the settings test do not), and because a payload queued in the
   * outbox before this field existed must still decode on the way out. The
   * worker falls back to the app icon whenever they are absent.
   */
  avatarShape: Schema.optional(BotAvatarShape),
  avatarColor: Schema.optional(BotAvatarColor),
});
export type PersonalPushPayload = typeof PersonalPushPayload.Type;

export class PersonalPushError extends Schema.TaggedError<PersonalPushError>()(
  "PersonalPushError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
