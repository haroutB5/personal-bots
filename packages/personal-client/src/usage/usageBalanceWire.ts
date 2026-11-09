import type { ServerProvider, ServerProviderUsageBalance } from "@t3tools/contracts";

/**
 * The prepaid balance a DeepSeek provider snapshot carries. Kept as an alias so
 * the usage card reads one name while the wire shape lives in the contracts.
 */
export type ServerProviderUsageBalanceWire = ServerProviderUsageBalance;

export type ProviderWithUsageBalance = ServerProvider & {
  readonly usageBalance?: ServerProviderUsageBalanceWire | undefined;
};
