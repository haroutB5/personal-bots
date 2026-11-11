/** A short, non-identifying name for this device in the device list. */
export function deviceLabelFrom(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows";
  return "This device";
}

export interface PushSubscribeInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly deviceLabel: string;
}

/** The server input for a browser subscription, or null when it is incomplete. */
export function subscribeInputFrom(
  json: PushSubscriptionJSON,
  userAgent: string,
): PushSubscribeInput | null {
  if (
    json.endpoint === undefined ||
    json.keys?.p256dh === undefined ||
    json.keys.auth === undefined
  ) {
    return null;
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    deviceLabel: deviceLabelFrom(userAgent),
  };
}

export type ResyncOutcome = "sent" | "skipped" | "failed";

/**
 * Tells the server about the subscription this browser already holds, so it is
 * bound to the current sign-in. The server matches on the endpoint, so a
 * repeat is an update, not a second device.
 *
 * It never asks for permission and never creates a subscription: with no
 * granted permission, no worker or no existing subscription it does nothing.
 * `send` resolves to null on success or the server's refusal message.
 */
export async function resyncPushSubscription(input: {
  readonly permission: NotificationPermission | "unsupported";
  readonly userAgent: string;
  readonly getRegistration: () => Promise<{
    readonly pushManager: Pick<PushManager, "getSubscription">;
  } | null>;
  readonly send: (subscribe: PushSubscribeInput) => Promise<string | null>;
}): Promise<ResyncOutcome> {
  if (input.permission !== "granted") return "skipped";
  const registration = await input.getRegistration();
  if (registration === null || !("pushManager" in registration)) return "skipped";
  const existing = await registration.pushManager.getSubscription();
  if (existing === null) return "skipped";
  const subscribeInput = subscribeInputFrom(existing.toJSON(), input.userAgent);
  if (subscribeInput === null) return "skipped";
  return (await input.send(subscribeInput)) === null ? "sent" : "failed";
}
