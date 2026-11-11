import type { PersonalPushSubscribeInput } from "@t3tools/contracts";

export const subscribeInputFrom = (
  _json: PushSubscriptionJSON,
  _userAgent: string,
): PersonalPushSubscribeInput | null => null;

export const resyncPushSubscription = async (
  _input: unknown,
): Promise<"sent" | "skipped" | "failed"> => "skipped";
