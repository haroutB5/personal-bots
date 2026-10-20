import {
  isLowProviderBalance,
  type PersonalBot,
  type ProviderDriverKind,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";

import { isProviderSettingsUpdateCandidate } from "~/components/ProviderUpdateLaunchNotification.logic";

import { resolveBotProvider } from "./botSummaries";
import { formatRetryTime } from "./conversationModel";
import { formatBalanceAmount, USAGE_CARD_DRIVERS } from "./usagePresentation";

/**
 * Settings > Providers: one row per provider, one status, at most one action
 * (provider-setup SPEC 3.3). The first state that matches wins, in the order
 * of the table: a provider being installed says so before it says anything
 * about its version.
 */
export type ProviderRowState =
  | "installing"
  | "updating"
  | "testing"
  | "removing"
  | "installFailed"
  | "wontStart"
  | "updateBroke"
  | "testFailed"
  | "modelGone"
  | "needsSignIn"
  | "notInstalled"
  | "updateFailed"
  | "waitingForLimit"
  | "lowBalance"
  | "updateAvailable"
  | "off"
  | "ready";

/** The status dot: none while something runs, a spinner while a test or removal runs. */
export type ProviderRowDot = "none" | "spinner" | "live" | "review" | "error" | "waiting" | "off";

export type ProviderRowActionKind =
  | "update"
  | "signIn"
  | "install"
  | "tryAgain"
  | "goBack"
  | "fix"
  | "testAgain";

export interface ProviderRowAction {
  readonly kind: ProviderRowActionKind;
  readonly label: string;
}

export interface ProviderRow {
  readonly instanceId: string;
  /** Null when the instance is not set up on this computer. */
  readonly driver: ProviderDriverKind | null;
  readonly label: string;
  readonly state: ProviderRowState;
  readonly dot: ProviderRowDot;
  readonly statusText: string;
  /** Review (amber) or error (red) colours the status words; normal leaves them quiet. */
  readonly tone: "normal" | "review" | "error";
  /** The provider's own words about a failure, at most two lines on screen. */
  readonly detail: string | null;
  readonly action: ProviderRowAction | null;
  /** A progress bar under the text; a null fraction slides (size unknown). */
  readonly progress: { readonly fraction: number | null } | null;
  /** Something is running on the server, so Check all leaves this row alone. */
  readonly busy: boolean;
  readonly bots: ReadonlyArray<string>;
  readonly canToggleUsage: boolean;
}

/** What a tap is doing while its request is still in flight. */
export type ProviderRowPending =
  | { readonly kind: "check" }
  | { readonly kind: "update" }
  | { readonly kind: "install" }
  | { readonly kind: "signIn" }
  | { readonly kind: "removing" }
  | { readonly kind: "goBack"; readonly version: string | null }
  | { readonly kind: "test" };

const MEGABYTE = 1_000_000;

function megabytes(bytes: number): string {
  return String(Math.max(0, Math.round(bytes / MEGABYTE)));
}

/** First line of a provider message, trimmed to fit a row's detail line. */
export function firstLine(text: string | null | undefined, max = 160): string | null {
  const line = text
    ?.split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** "Musey uses it", "Musey and Scout use it", "3 bots use it". */
export function botsUseText(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} uses it`;
  if (names.length === 2) return `${names[0]} and ${names[1]} use it`;
  return `${names.length} bots use it`;
}

/** "Watcher and Musey", "Watcher, Musey and Scout", "3 bots". */
export function botsNamed(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names.length} bots`;
}

/** The names of the bots that use an instance as their model, fallback or schedule. */
export function botsUsingProvider(
  instanceId: string,
  bots: ReadonlyArray<PersonalBot>,
): ReadonlyArray<string> {
  return bots
    .toSorted((left, right) => left.sortOrder - right.sortOrder)
    .filter(
      (bot) =>
        bot.modelSelection.instanceId === instanceId ||
        (bot.fallback?.enabled === true && bot.fallback.modelSelection.instanceId === instanceId) ||
        (bot.schedule?.enabled === true && bot.schedule.modelSelection.instanceId === instanceId),
    )
    .map((bot) => bot.name);
}

/** The bots whose own model is one of `slugs` on this instance. */
export function botsUsingModels(
  instanceId: string,
  slugs: ReadonlyArray<string>,
  bots: ReadonlyArray<PersonalBot>,
): ReadonlyArray<PersonalBot> {
  return bots
    .toSorted((left, right) => left.sortOrder - right.sortOrder)
    .filter(
      (bot) =>
        bot.modelSelection.instanceId === instanceId && slugs.includes(bot.modelSelection.model),
    );
}

/** Installed, signed in and with usage to show: the Use card offers Show usage. */
export function providerReportsUsage(snapshot: ServerProvider): boolean {
  return (
    snapshot.installed &&
    snapshot.enabled &&
    ((USAGE_CARD_DRIVERS as ReadonlyArray<string>).includes(snapshot.driver) ||
      (snapshot.usageLimits?.windows.length ?? 0) > 0)
  );
}

/**
 * Signed out, or (for a provider the app signs in itself) not known to be
 * signed in: Antigravity reports "unknown" until a sign-in has been tried, and
 * the page must offer it then.
 */
export function providerNeedsSignIn(snapshot: ServerProvider): boolean {
  if (snapshot.auth.status === "unauthenticated") return true;
  return snapshot.setup?.canAuthenticate === true && snapshot.auth.status !== "authenticated";
}

const INSTALL_ACTIVE = new Set<ProviderInstallState["phase"]>([
  "downloading",
  "extracting",
  "verifying",
]);

export function isInstallActive(install: ProviderInstallState | null | undefined): boolean {
  return install !== null && install !== undefined && INSTALL_ACTIVE.has(install.phase);
}

/** The fresh smoke verdict for the installed version, if any. */
export function currentSmoke(snapshot: ServerProvider): ServerProvider["smokeCheck"] | undefined {
  const smoke = snapshot.smokeCheck;
  return smoke !== undefined && smoke.version === snapshot.version ? smoke : undefined;
}

function installingText(install: ProviderInstallState): { text: string; fraction: number | null } {
  if (install.phase === "downloading") {
    const total = install.totalBytes;
    if (total !== null && total > 0) {
      return {
        text: `Installing · ${megabytes(install.downloadedBytes)} of ${megabytes(total)} MB`,
        fraction: Math.min(1, install.downloadedBytes / total),
      };
    }
    return { text: "Installing…", fraction: null };
  }
  if (install.phase === "extracting") return { text: "Unpacking…", fraction: null };
  return { text: "Checking it starts…", fraction: null };
}

/** "Test waits for usage limit · 12:47"; no time when the server has none. */
function waitingForLimitText(retryAt: string | undefined, now: Date): string {
  const at = retryAt === undefined ? Number.NaN : Date.parse(retryAt);
  return Number.isFinite(at)
    ? `Test waits for usage limit · ${formatRetryTime(new Date(at), now)}`
    : "Test waits for usage limit";
}

export interface ProviderRowInput {
  readonly snapshot: ServerProvider;
  readonly label: string;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly install: ProviderInstallState | null;
  readonly now: Date;
}

/** One provider's row. Pure: everything comes from the snapshot, the bots and the install stream. */
export function providerRow(input: ProviderRowInput): ProviderRow {
  const { snapshot, label, install, now } = input;
  const users = botsUsingProvider(snapshot.instanceId, input.bots);
  const update = snapshot.updateState;
  const advisory = snapshot.versionAdvisory;
  const smoke = currentSmoke(snapshot);
  const oneClick = isProviderSettingsUpdateCandidate(snapshot);
  const canInstall = snapshot.setup?.canInstall === true;

  const base = {
    instanceId: snapshot.instanceId,
    driver: snapshot.driver,
    label,
    bots: users,
    progress: null,
    detail: null,
    action: null,
    busy: false,
    tone: "normal" as const,
    canToggleUsage: providerReportsUsage(snapshot),
  };
  const row = (
    state: ProviderRowState,
    dot: ProviderRowDot,
    statusText: string,
    extra: Partial<ProviderRow> = {},
  ): ProviderRow => ({ ...base, state, dot, statusText, ...extra });

  // 1. Installing
  if (install !== null && isInstallActive(install)) {
    const { text, fraction } = installingText(install);
    return row("installing", "none", text, { progress: { fraction }, busy: true });
  }
  // 2. Updating
  if (update?.status === "running" || update?.status === "queued") {
    const latest = advisory?.latestVersion ?? null;
    return row(
      "updating",
      "none",
      update.status === "queued"
        ? "Waiting for another update to finish"
        : latest === null
          ? "Updating…"
          : `Updating to ${latest}…`,
      { progress: { fraction: null }, busy: true },
    );
  }
  // 3. Testing
  if (smoke?.status === "checking") {
    return row("testing", "spinner", `Testing ${smoke.version} with one message…`, { busy: true });
  }
  // 5. Install failed
  if (install?.phase === "failed") {
    return row("installFailed", "error", "Install failed", {
      tone: "error",
      detail: firstLine(install.message),
      action: canInstall ? { kind: "tryAgain", label: "Try again" } : null,
    });
  }
  // 6. Won't start
  if (snapshot.installed && snapshot.status === "error") {
    return row("wontStart", "error", "Installed, but it won't start", {
      tone: "error",
      detail: firstLine(snapshot.message),
      action: { kind: "tryAgain", label: "Try again" },
    });
  }
  // 7. Update broke (the version changed under the bots and the test failed)
  if (smoke?.status === "failed" && smoke.manual !== true) {
    const canGoBack = smoke.previousVersion !== undefined && advisory?.canInstallVersion === true;
    return row("updateBroke", "review", `Update broke ${label}`, {
      tone: "review",
      detail: `${smoke.version} failed the test message.${
        smoke.previousVersion !== undefined ? ` ${smoke.previousVersion} worked.` : ""
      }`,
      action: canGoBack
        ? { kind: "goBack", label: "Go back" }
        : { kind: "testAgain", label: "Test again" },
    });
  }
  // The owner's own test failed: not about an update.
  if (smoke?.status === "failed") {
    return row("testFailed", "error", "Test message failed", {
      tone: "error",
      detail: firstLine(smoke.message),
      action: { kind: "testAgain", label: "Test again" },
    });
  }
  // 8. Model gone: the test passed on the default model but bots point at one the provider dropped
  if (
    smoke?.status === "passed" &&
    smoke.missingModels !== undefined &&
    smoke.missingModels.length > 0
  ) {
    const affected = botsUsingModels(snapshot.instanceId, smoke.missingModels, input.bots).map(
      (bot) => bot.name,
    );
    const dropped = smoke.missingModels.join(", ");
    return row("modelGone", "review", "A model your bots use is gone", {
      tone: "review",
      detail:
        affected.length > 0
          ? `${label} dropped ${dropped}. ${botsNamed(affected)} ${affected.length === 1 ? "uses" : "use"} it.`
          : `${label} dropped ${dropped}.`,
      action: { kind: "fix", label: "Fix" },
    });
  }
  // 9. Needs sign-in
  if (snapshot.installed && snapshot.enabled && providerNeedsSignIn(snapshot)) {
    return row("needsSignIn", "review", "Sign in to use it", {
      tone: "review",
      action: { kind: "signIn", label: "Sign in" },
    });
  }
  // 10. Not installed, a bot uses it
  if (!snapshot.installed) {
    const used = botsUseText(users);
    return row(
      "notInstalled",
      "review",
      used === null ? "Not installed" : `Not installed · ${used}`,
      {
        tone: used === null ? "normal" : "review",
        detail: canInstall || used === null ? null : "Install it on your computer.",
        action: canInstall ? { kind: "install", label: "Install" } : null,
      },
    );
  }
  // 11. Update failed
  if (update?.status === "failed") {
    return row("updateFailed", "review", "Update failed", {
      tone: "review",
      detail: firstLine(update.message),
      action: { kind: "tryAgain", label: "Try again" },
    });
  }
  // 12. Waiting for the usage limit
  if (smoke?.status === "waiting_for_limit") {
    return row("waitingForLimit", "waiting", waitingForLimitText(smoke.retryAt, now));
  }
  // 13. Low balance (prepaid)
  const balance = snapshot.usageBalance;
  if (
    balance?.status === "ready" &&
    balance.balance?.isAvailable === true &&
    isLowProviderBalance({
      currency: balance.balance.currency,
      totalBalance: balance.balance.totalBalance,
    })
  ) {
    return row(
      "lowBalance",
      "review",
      `Balance ${formatBalanceAmount(balance.balance.totalBalance, balance.balance.currency)} · top up soon`,
      { tone: "review" },
    );
  }
  // 14. Update available
  if (advisory?.status === "behind_latest") {
    return row(
      "updateAvailable",
      "live",
      advisory.latestVersion === null ? "New version" : `New version ${advisory.latestVersion}`,
      {
        detail: oneClick ? null : "Update it on your computer.",
        action: oneClick ? { kind: "update", label: "Update" } : null,
      },
    );
  }
  // 15. Off
  if (!snapshot.enabled) {
    return row("off", "off", "Off · bots can't use it");
  }
  // 16. Ready
  const version =
    snapshot.version === null ? "Version not reported" : `Version ${snapshot.version}`;
  return row("ready", "live", advisory?.status === "current" ? `${version} · Up to date` : version);
}

/**
 * The row while a tap's request is still in flight. The server publishes its
 * own state a moment later (seconds for a recheck); without this the row looks
 * untouched. A server state that is already in progress wins.
 */
export function withPendingAction(
  row: ProviderRow,
  pending: ProviderRowPending | null,
): ProviderRow {
  if (pending === null || row.busy) return row;
  const text =
    pending.kind === "check"
      ? "Checking…"
      : pending.kind === "update"
        ? "Starting update…"
        : pending.kind === "install"
          ? "Starting install…"
          : pending.kind === "signIn"
            ? "Starting sign-in…"
            : pending.kind === "removing"
              ? "Removing…"
              : pending.kind === "test"
                ? "Starting test…"
                : pending.version === null
                  ? "Going back…"
                  : `Going back to ${pending.version}…`;
  return {
    ...row,
    dot: pending.kind === "removing" || pending.kind === "test" ? "spinner" : "none",
    statusText: text,
    tone: "normal",
    detail: null,
    action: null,
    busy: true,
  };
}

export interface ProviderList {
  /** The Settings rows: installed, being installed, or used by a bot. */
  readonly rows: ReadonlyArray<ProviderRow>;
  /** Built-ins that are not installed and nobody uses: they live in Add provider. */
  readonly addable: ReadonlyArray<ProviderRow>;
}

/**
 * Settings > Providers lists a provider that is installed, being installed, or
 * used by a bot (as its model, fallback or schedule), bots' providers first in
 * bot order, then the rest by name. The others are offered in Add provider.
 * A provider a bot uses that this computer has no snapshot for still gets a row.
 */
export function buildProviderList(
  providers: ReadonlyArray<ServerProvider>,
  bots: ReadonlyArray<PersonalBot>,
  installs: ReadonlyMap<string, ProviderInstallState>,
  now: Date = new Date(),
): ProviderList {
  const rows: Array<ProviderRow> = [];
  const addable: Array<ProviderRow> = [];
  const seen = new Set<string>();
  const rowFor = (snapshot: ServerProvider): ProviderRow =>
    providerRow({
      snapshot,
      label: resolveBotProvider(snapshot.instanceId, providers).label,
      bots,
      install: installs.get(snapshot.instanceId) ?? null,
      now,
    });

  const instanceIdsOfBots = new Set<string>();
  for (const bot of bots.toSorted((left, right) => left.sortOrder - right.sortOrder)) {
    for (const selection of [
      bot.modelSelection,
      ...(bot.fallback?.enabled === true ? [bot.fallback.modelSelection] : []),
      ...(bot.schedule?.enabled === true ? [bot.schedule.modelSelection] : []),
    ]) {
      const instanceId = selection.instanceId;
      if (instanceIdsOfBots.has(instanceId)) continue;
      instanceIdsOfBots.add(instanceId);
      seen.add(instanceId);
      const snapshot = providers.find((candidate) => candidate.instanceId === instanceId);
      if (snapshot === undefined) {
        const { label } = resolveBotProvider(instanceId, providers);
        rows.push({
          instanceId,
          driver: null,
          label,
          state: "notInstalled",
          dot: "review",
          statusText: "Not set up on this computer",
          tone: "review",
          detail: null,
          action: null,
          progress: null,
          busy: false,
          bots: botsUsingProvider(instanceId, bots),
          canToggleUsage: false,
        });
        continue;
      }
      rows.push(rowFor(snapshot));
    }
  }

  const rest: Array<ProviderRow> = [];
  for (const snapshot of providers) {
    if (seen.has(snapshot.instanceId)) continue;
    seen.add(snapshot.instanceId);
    const install = installs.get(snapshot.instanceId) ?? null;
    const listed =
      snapshot.installed ||
      isInstallActive(install) ||
      install?.phase === "failed" ||
      snapshot.availability === "unavailable";
    (listed ? rest : addable).push(rowFor(snapshot));
  }
  const byName = (left: ProviderRow, right: ProviderRow) => left.label.localeCompare(right.label);
  rows.push(...rest.toSorted(byName));
  return { rows, addable: addable.toSorted(byName) };
}
