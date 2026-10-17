import {
  PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
  PERSONAL_FALLBACK_REASON_SCHEDULE,
  type PersonalBot,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { fallbackModelLabel } from "../../../personal/personalModelFallbackPolicy.ts";

/**
 * The read-only usage reading the `usage_status` tool returns. It is shaped
 * from the same provider snapshots the Bots home header reads
 * (`ProviderRegistry.getProviders`) and the same bot rows the home shows, so
 * it never fetches a provider again or keeps a second copy of the numbers.
 */
export interface UsageWindowReading {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

export interface UsageProviderReading {
  readonly instanceId: string;
  readonly driver: string;
  readonly name: string;
  readonly status: string;
  /** When the provider last reported these figures. */
  readonly checkedAt: string | null;
  /** Why there are no figures, when the provider said. */
  readonly unavailable: string | null;
  /** The 5-hour session window, when reported. */
  readonly session: UsageWindowReading | null;
  /** Every weekly window, in the provider's own order. */
  readonly weekly: ReadonlyArray<UsageWindowReading>;
}

export interface UsageFallbackBotReading {
  readonly botId: string;
  readonly botName: string;
  /** The model the owner saved (what the bot runs on when not on a fallback). */
  readonly homeModel: string;
  /** The model the bot's turns use right now. */
  readonly activeModel: string;
  readonly activeModelLabel: string;
  /** usage_limit, deepseek_peak or schedule. */
  readonly reason: string;
  readonly fromProvider: string | null;
  readonly since: string | null;
  readonly resetAt: string | null;
}

export interface UsageStatusReading {
  /** When this reading was taken, ISO 8601. */
  readonly readAt: string;
  readonly providers: ReadonlyArray<UsageProviderReading>;
  readonly fallbackBots: ReadonlyArray<UsageFallbackBotReading>;
}

function windowReading(window: ServerProviderUsageWindow): UsageWindowReading {
  return {
    id: window.id,
    label: window.label,
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    resetsAt: window.resetsAt ?? null,
  };
}

/**
 * The same window choice the home header makes: the first `session` window,
 * else one whose id names the five-hour bucket; every `weekly` window, else
 * every id that names a seven-day or week bucket, deduped by id.
 */
export function pickUsageWindows(windows: ReadonlyArray<ServerProviderUsageWindow>): {
  readonly session: UsageWindowReading | null;
  readonly weekly: ReadonlyArray<UsageWindowReading>;
} {
  const sessionWindow =
    windows.find((window) => window.kind === "session") ??
    windows.find((window) => window.id.toLowerCase().includes("five_hour"));
  const directWeeklies = windows.filter((window) => window.kind === "weekly");
  const weeklySource =
    directWeeklies.length > 0
      ? directWeeklies
      : windows.filter((window) => {
          const id = window.id.toLowerCase();
          return id.includes("seven_day") || id.includes("week");
        });
  const seen = new Set<string>();
  const weekly: Array<UsageWindowReading> = [];
  for (const window of weeklySource) {
    if (seen.has(window.id)) continue;
    seen.add(window.id);
    weekly.push(windowReading(window));
  }
  return {
    session: sessionWindow === undefined ? null : windowReading(sessionWindow),
    weekly,
  };
}

/** One provider's reading, or null when the header would draw no card for it. */
export function usageProviderReading(provider: ServerProvider): UsageProviderReading | null {
  // The header only draws an enabled, installed instance.
  if (!provider.enabled || !provider.installed) return null;
  const windows = pickUsageWindows(provider.usageLimits?.windows ?? []);
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    name: provider.displayName ?? provider.instanceId,
    status: provider.status,
    checkedAt: provider.usageLimits?.checkedAt ?? null,
    unavailable:
      provider.usageLimits?.unavailable?.message ??
      provider.usageLimits?.unavailable?.reason ??
      null,
    ...windows,
  };
}

/** A decoded Utc, or an ISO string from a wire row, as an ISO string. */
const isoString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return DateTime.formatIso(value as Parameters<typeof DateTime.formatIso>[0]);
};

function fallbackReason(bot: PersonalBot): string | null {
  const active = bot.fallbackActive;
  if (active === undefined) return null;
  if (active.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK) return "deepseek_peak";
  if (active.reason === PERSONAL_FALLBACK_REASON_SCHEDULE) return "schedule";
  return "usage_limit";
}

/** Every bot whose turns currently use a fallback, peak or scheduled model. */
export function usageFallbackBots(
  bots: ReadonlyArray<PersonalBot>,
): ReadonlyArray<UsageFallbackBotReading> {
  return bots.flatMap((bot): Array<UsageFallbackBotReading> => {
    const active = bot.fallbackActive;
    const reason = fallbackReason(bot);
    if (active === undefined || reason === null) return [];
    return [
      {
        botId: bot.botId,
        botName: bot.name,
        homeModel: fallbackModelLabel(bot.modelSelection),
        activeModel: active.modelSelection.model,
        activeModelLabel: fallbackModelLabel(active.modelSelection),
        reason,
        fromProvider: active.fromProvider ?? null,
        since: isoString(active.since),
        resetAt: isoString(active.resetAt),
      },
    ];
  });
}

/** The whole reading, from the published provider and bot rows. */
export function usageStatusReading(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly readAt: string;
}): UsageStatusReading {
  return {
    readAt: input.readAt,
    providers: input.providers.flatMap((provider) => {
      const reading = usageProviderReading(provider);
      return reading === null ? [] : [reading];
    }),
    fallbackBots: usageFallbackBots(input.bots),
  };
}
