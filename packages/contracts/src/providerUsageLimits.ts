import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  /** Successful full probe for these exact windows. Sparse runtime merges drop this proof. */
  fullReadAt: Schema.optional(IsoDateTime),
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
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

/** API-price value of the turns our transcripts hold, from the usage scan at published Flash rates (USD). */
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
 * At or below this (USD) a prepaid balance is called low: the card shows its
 * warning line, and the server sends one notice per low spell.
 */
export const PROVIDER_LOW_BALANCE_USD = 1;

/** A low spell ends, and can be reported again, above this (USD): a top-up. */
export const PROVIDER_LOW_BALANCE_REARM_USD = 1.5;

/**
 * True when a reading is low enough to warn about.
 *
 * USD only, deliberately: DeepSeek reports the account's own currency and the
 * app never converts or invents a rate, so a CNY-only account is left alone
 * rather than measured against a dollar line.
 */
export const isLowProviderBalance = (amounts: {
  readonly currency: string;
  readonly totalBalance: number;
}): boolean =>
  amounts.currency.toUpperCase() === "USD" && amounts.totalBalance <= PROVIDER_LOW_BALANCE_USD;

/**
 * A provider's prepaid balance. `balance` is kept from the last good read when
 * the newest one failed. `message` is a short safe reason, never raw error text.
 * `spent` comes from our own scan and is absent when there is nothing to price.
 */
export const ServerProviderUsageBalance = Schema.Struct({
  checkedAt: IsoDateTime,
  status: Schema.Literals(["ready", "failed"]),
  balance: Schema.optional(ServerProviderBalance),
  spent: Schema.optional(ServerProviderSpend),
  message: Schema.optional(TrimmedNonEmptyString),
  /** Why a failed read failed. `auth_error` means the key was rejected; a 429 or 5xx is `http_error`. */
  failureReason: Schema.optional(
    Schema.Literals([
      "missing_key",
      "auth_error",
      "insufficient_balance",
      "http_error",
      "network_error",
      "timeout",
      "invalid_response",
    ]),
  ),
});
export type ServerProviderUsageBalance = typeof ServerProviderUsageBalance.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

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

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

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
