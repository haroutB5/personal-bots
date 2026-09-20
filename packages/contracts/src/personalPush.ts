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
 * The server holds back that chat's notifications while it is being viewed.
 * Sent on open, visibility change and as a heartbeat; entries expire.
 */
export const PersonalPushViewingInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});
export type PersonalPushViewingInput = typeof PersonalPushViewingInput.Type;

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
