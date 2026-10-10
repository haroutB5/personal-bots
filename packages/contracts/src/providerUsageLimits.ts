import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/**
 * One rolling quota window a subscription provider reports for the signed-in
 * account, e.g. Claude's five-hour session or Codex's weekly allowance.
 *
 * `id` is stable per provider (`five_hour`, `seven_day_opus`, `primary`) so a
 * sparse turn-driven update lands on the same row a full probe produced.
 * `kind` only orders and labels the bar.
 */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/**
 * Reset credits a provider banks on the account. Codex grants these when it
 * has rate-limited the user unfairly; redeeming one clears the current
 * windows. Only present when the provider reports them at all.
 */
export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/**
 * Subscription usage the provider knows about the signed-in account.
 *
 * `unavailable` distinguishes an account that can never report windows (API
 * key, Bedrock) from a probe that failed this time, so clients can keep the
 * last good bars for the latter and clear them for the former.
 *
 * `refreshFailed` rides on a kept reading: the windows are the last good ones
 * (`checkedAt` says how old), and the newest probe could not read usage, at the
 * time and for the short reason given. A successful read replaces the whole
 * object, so it never outlives the failure.
 */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  /** Successful full probe for these exact windows. Sparse runtime merges drop this proof. */
  fullReadAt: Schema.optional(IsoDateTime),
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  refreshFailed: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * Prepaid credit an API-key provider reports, in the provider's own currency.
 *
 * `grantedBalance` is free credit the provider gave, `toppedUpBalance` is what
 * was paid for; both are spendable, and `totalBalance` is their sum as the
 * provider reports it (never recomputed here).
 */
export const ServerProviderBalance = Schema.Struct({
  currency: TrimmedNonEmptyString,
  totalBalance: Schema.Number,
  grantedBalance: Schema.Number,
  toppedUpBalance: Schema.Number,
  /** The provider's own answer to "can this account make API calls". */
  isAvailable: Schema.Boolean,
  /**
   * When the provider returned these numbers. May be older than the
   * enclosing `checkedAt`: reads are cached so the provider is not hammered.
   */
  fetchedAt: IsoDateTime,
});
export type ServerProviderBalance = typeof ServerProviderBalance.Type;

/**
 * API-price value of the turns our own transcript records still hold, for a
 * provider whose only money endpoint reports what is left (DeepSeek).
 *
 * Computed from the usage scan, not from the provider: every record is priced
 * at DeepSeek's published DeepSeek-V4-Flash rates (the picker offers Flash
 * only), in USD. The balance endpoint stays the independent check.
 */
export const ServerProviderSpend = Schema.Struct({
  /** USD, at the published rates. Never converted from the balance's currency. */
  costUsd: Schema.Number,
  /** Earliest record the figure covers; the "since" it is shown with. */
  since: IsoDateTime,
  /** Transcript records folded into the figure, after de-duplication. */
  records: NonNegativeInt,
});
export type ServerProviderSpend = typeof ServerProviderSpend.Type;

/**
 * What a provider knows about its prepaid balance (DeepSeek today).
 *
 * `status` says how the newest read attempt went; `balance` is what to show,
 * and is kept from the last good read when the newest one failed, so the
 * numbers never flap to nothing for one bad poll. `message` is a short,
 * safe-to-show reason and never the provider's raw error text.
 *
 * `spent` is our own scan's figure, independent of the balance read: it is
 * present only when there are records to price, and never invented when there
 * are none.
 */
export const ServerProviderUsageBalance = Schema.Struct({
  checkedAt: IsoDateTime,
  status: Schema.Literals(["ready", "failed"]),
  balance: Schema.optional(ServerProviderBalance),
  spent: Schema.optional(ServerProviderSpend),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageBalance = typeof ServerProviderUsageBalance.Type;

/**
 * What an adapter reports when its runtime pushes a rate-limit update during
 * a turn. Sparse by contract: Claude's `rate_limit_event` names one window at
 * a time and Codex documents its notification as a partial. Windows merge by
 * `id` onto the instance's published snapshot; omitted windows are unchanged.
 */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

/**
 * One account a usage-limit source reports on. `driver` is the provider the
 * account belongs to, for the icon and colour clients already have; the
 * account itself is not something this environment can run turns on.
 */
export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** The signed-in address, when the source names one; clients blur it like provider auth. */
  email: Schema.optional(TrimmedNonEmptyString),
  /** Plan as the matching provider would label it (`ChatGPT Pro 20x Subscription`). */
  plan: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

/**
 * The published state of one configured `usageLimitSources` entry. A source
 * that could not be read keeps `error` beside an empty account list rather
 * than vanishing, so the user can see it is configured but failing.
 */
export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Mirrors Codex's own outcome set; other providers map onto it. */
export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  /** Redemption succeeded, but a follow-up such as clearing the hub cooldown failed. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

/** A point-in-time view of one provider's limits, built for the /usage-limits panel. */
export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
