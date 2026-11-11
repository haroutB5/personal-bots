import { hidesBotPreviews } from "@hbots/personal-client/conversation/previewPrivacy";

import type { Lock } from "../security/appLock";
import type { PolicyBot } from "./nativeNotify";

export interface BotRecord {
  readonly botId: string;
  readonly name?: string | null;
  readonly hidePreviews?: boolean;
}

export interface NativePolicy {
  readonly appLockOn: boolean;
  readonly bots: ReadonlyArray<PolicyBot>;
}

/** The most bots the native side keeps. It rejects more, and a long list is a mistake anyway. */
export const MAX_POLICY_BOTS = 500;

/**
 * What the push service needs while JS is not running: whether the app lock is on and which
 * bots exist, with their names and the hide-previews switch. A bot without a name is "hbots".
 * Only the lock flag and the switch decide what a notification may show, so nothing else crosses.
 */
export function buildNativePolicy(bots: ReadonlyArray<BotRecord>, lock: Lock): NativePolicy {
  return {
    appLockOn: lock.kind === "on",
    bots: bots.slice(0, MAX_POLICY_BOTS).map((bot) => ({
      botId: bot.botId,
      name: bot.name?.trim() ? bot.name.trim() : "hbots",
      hidePreviews: hidesBotPreviews(bot),
    })),
  };
}
