import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderRow } from "@hbots/personal-client/settings/providerRows";

export type ProviderUpdateTarget = ProviderRow & {
  readonly driver: ProviderDriverKind;
  readonly action: { readonly kind: "update"; readonly label: string };
};

export interface ProviderUpdateFailure {
  readonly instanceId: string;
  readonly label: string;
  readonly message: string;
}

export function updateAllTargets(
  rows: ReadonlyArray<ProviderRow>,
): ReadonlyArray<ProviderUpdateTarget> {
  return rows.filter(
    (row): row is ProviderUpdateTarget =>
      !row.busy && row.driver !== null && row.action?.kind === "update",
  );
}

export async function runProviderUpdates(
  rows: ReadonlyArray<ProviderRow>,
  start: (target: ProviderUpdateTarget) => Promise<string | null>,
): Promise<ReadonlyArray<ProviderUpdateFailure>> {
  const failures: Array<ProviderUpdateFailure> = [];
  for (const target of updateAllTargets(rows)) {
    const message = await start(target);
    if (message !== null) {
      failures.push({ instanceId: target.instanceId, label: target.label, message });
    }
  }
  return failures;
}

export function updateFailureLines(failures: ReadonlyArray<ProviderUpdateFailure>): string {
  return failures.map((failure) => `${failure.label}: ${failure.message}`).join("\n");
}
