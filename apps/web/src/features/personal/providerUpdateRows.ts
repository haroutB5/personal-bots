import type {
  PersonalBot,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
} from "~/components/ProviderUpdateLaunchNotification.logic";

import { resolveBotProvider } from "./botSummaries";

export interface ProviderUpdateRow {
  readonly instanceId: ProviderInstanceId;
  /** Null when the instance is not set up on this computer. */
  readonly driver: ProviderDriverKind | null;
  readonly label: string;
  /** "Version 2.1.263", "Version not reported", "Not installed". */
  readonly version: string;
  readonly status: { readonly text: string; readonly tone: "normal" | "review" } | null;
  /** The provider's own words about a failed test or update. */
  readonly detail: string | null;
  /** One-click update is offered (the existing provider update command). */
  readonly canUpdate: boolean;
  /** An update is queued or running. */
  readonly busy: boolean;
  readonly canCheck: boolean;
}

/**
 * One Settings row per provider, bots' providers first (in bot order), then
 * every other provider set up on this computer. Every label comes from the
 * provider snapshot: version, advisory, update state and the post-update test
 * verdict for the installed version.
 *
 * Listing the unused ones matters: a provider is installed on the machine, not
 * on a bot, so deleting the last Codex bot used to remove the only place to
 * update the Codex CLI - while the usage strip went on reporting Codex usage.
 */
export function buildProviderUpdateRows(
  providers: ReadonlyArray<ServerProvider>,
  bots: ReadonlyArray<PersonalBot>,
): ReadonlyArray<ProviderUpdateRow> {
  const rows: Array<ProviderUpdateRow> = [];
  const seen = new Set<string>();
  for (const bot of bots.toSorted((left, right) => left.sortOrder - right.sortOrder)) {
    const instanceId = bot.modelSelection.instanceId;
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    const { label } = resolveBotProvider(instanceId, providers);
    const snapshot = providers.find((candidate) => candidate.instanceId === instanceId);
    rows.push(
      snapshot === undefined
        ? {
            instanceId,
            driver: null,
            label,
            version: "Not set up on this computer",
            status: null,
            detail: null,
            canUpdate: false,
            busy: false,
            canCheck: false,
          }
        : providerUpdateRow(snapshot, label),
    );
  }
  for (const snapshot of providers) {
    if (seen.has(snapshot.instanceId)) continue;
    seen.add(snapshot.instanceId);
    rows.push(
      providerUpdateRow(snapshot, resolveBotProvider(snapshot.instanceId, providers).label),
    );
  }
  return rows;
}

export type ProviderRowAction = "check" | "update";

/**
 * The row while a tap's request is still in flight. Check again refreshes the
 * provider before the server publishes its own checking state, which takes
 * seconds; without this the row looks untouched. Server state that is already
 * in progress (testing, updating) wins.
 */
export function withPendingAction(
  row: ProviderUpdateRow,
  action: ProviderRowAction | null,
): ProviderUpdateRow {
  if (action === null) return row;
  const serverBusy = row.busy || !row.canCheck;
  return {
    ...row,
    status: serverBusy
      ? row.status
      : { text: action === "check" ? "Checking…" : "Starting update…", tone: "normal" },
    detail: serverBusy ? row.detail : null,
    canUpdate: false,
    canCheck: false,
  };
}

export function providerUpdateRow(snapshot: ServerProvider, label: string): ProviderUpdateRow {
  const update = snapshot.updateState;
  const advisory = snapshot.versionAdvisory;
  // A verdict about another version says nothing about the installed one.
  const smoke =
    snapshot.smokeCheck !== undefined && snapshot.smokeCheck.version === snapshot.version
      ? snapshot.smokeCheck
      : undefined;
  const busy = isProviderUpdateActive(snapshot);
  const oneClick = isProviderSettingsUpdateCandidate(snapshot);

  let status: ProviderUpdateRow["status"] = null;
  let detail: string | null = null;
  if (update?.status === "running") {
    status = { text: "Updating…", tone: "normal" };
  } else if (update?.status === "queued") {
    status = { text: "Waiting for another update to finish", tone: "normal" };
  } else if (smoke?.status === "checking") {
    status = { text: `Testing ${smoke.version} with one message…`, tone: "normal" };
  } else if (smoke?.status === "failed") {
    status = { text: `Update broke ${label}`, tone: "review" };
    detail = smoke.message;
  } else if (update?.status === "failed") {
    status = { text: "Update failed", tone: "review" };
    detail = update.message;
  } else if (advisory?.status === "behind_latest") {
    status = {
      text:
        advisory.latestVersion === null
          ? "Update available"
          : `Update available ${advisory.latestVersion}`,
      tone: "normal",
    };
    if (!oneClick) detail = "Update it on your computer.";
  } else if (update?.status === "unchanged") {
    status = { text: "Update ran, version unchanged", tone: "review" };
    detail = update.message;
  } else if (update?.status === "succeeded") {
    status = { text: "Updated", tone: "normal" };
  } else if (advisory?.status === "current") {
    status = { text: "Up to date", tone: "normal" };
  }

  return {
    instanceId: snapshot.instanceId,
    driver: snapshot.driver,
    label,
    version: !snapshot.installed
      ? "Not installed"
      : snapshot.version === null
        ? "Version not reported"
        : `Version ${snapshot.version}`,
    status,
    detail,
    canUpdate: !busy && oneClick,
    busy,
    canCheck: !busy && smoke?.status !== "checking",
  };
}
