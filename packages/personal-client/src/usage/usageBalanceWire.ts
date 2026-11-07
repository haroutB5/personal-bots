import type { ServerProvider } from "@t3tools/contracts";

/**
 * The prepaid balance a DeepSeek provider snapshot carries. It follows the
 * DeepSeek provider contract (D1), which is not in `@t3tools/contracts` yet.
 */
export interface ServerProviderUsageBalanceWire {
  readonly checkedAt: string;
  readonly status: "ready" | "failed";
  readonly balance?: {
    readonly currency: string;
    readonly totalBalance: number;
    readonly grantedBalance: number;
    readonly toppedUpBalance: number;
    readonly isAvailable: boolean;
    readonly fetchedAt: string;
  };
  readonly spent?: {
    readonly costUsd: number;
    readonly since: string;
    readonly records: number;
  };
  readonly message?: string;
}

export type ProviderWithUsageBalance = ServerProvider & {
  readonly usageBalance?: ServerProviderUsageBalanceWire | undefined;
};
