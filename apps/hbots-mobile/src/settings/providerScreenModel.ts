import {
  defaultInstanceIdForDriver,
  type PersonalBot,
  ProviderInstallState,
  ServerProvider,
  ServerProviderModel,
  ProviderInstanceConfig,
  ServerSettings,
} from "@t3tools/contracts";
import {
  botsUsingProvider,
  providerRow,
  type ProviderRow,
  type ProviderRowActionKind,
} from "@hbots/personal-client/settings/providerRows";

export type ProviderScreenTone = "ready" | "setup" | "review" | "error";

export interface ProviderScreenModel {
  readonly label: string;
  readonly row: ProviderRow;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authNeeded: boolean;
  readonly canTest: boolean;
  readonly users: ReadonlyArray<string>;
  readonly version: string | null;
  readonly publisher: string | null;
  readonly openSource: boolean | null;
  readonly license: string | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly tone: ProviderScreenTone;
}

export function providerScreenModel(input: {
  readonly snapshot: ServerProvider;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly install: ProviderInstallState | null;
  readonly now?: Date;
}): ProviderScreenModel {
  const { snapshot } = input;
  const row = providerRow({
    snapshot,
    label: snapshot.displayName ?? snapshot.driver,
    bots: input.bots,
    install: input.install,
    now: input.now ?? new Date(),
  });
  const authNeeded = snapshot.installed && snapshot.auth.status !== "authenticated";
  const tone: ProviderScreenTone =
    row.state === "installFailed" ||
    row.state === "wontStart" ||
    row.state === "updateBroke" ||
    row.state === "testFailed" ||
    row.state === "modelGone" ||
    row.state === "updateFailed"
      ? "error"
      : authNeeded || !snapshot.installed
        ? "setup"
        : row.tone === "review"
          ? "review"
          : "ready";
  return {
    label: row.label,
    row,
    installed: snapshot.installed,
    enabled: snapshot.enabled,
    authNeeded,
    canTest: snapshot.setup?.canTest === true,
    users: botsUsingProvider(snapshot.instanceId, input.bots),
    version: snapshot.version,
    publisher: snapshot.publisher ?? null,
    openSource: snapshot.openSource ?? null,
    license: snapshot.license ?? null,
    models: snapshot.models,
    tone,
  };
}

export function providerActionIntent(row: ProviderRow): ProviderRowActionKind | null {
  return row.action?.kind ?? null;
}

export function modelsShown(
  models: ReadonlyArray<ServerProviderModel>,
  expanded: boolean,
): ReadonlyArray<ServerProviderModel> {
  return expanded ? models : models.slice(0, 3);
}

export function versionLine(snapshot: ServerProvider, now: Date): string {
  if (snapshot.version === null) return "Version not reported";
  const advisory = snapshot.versionAdvisory;
  if (advisory === undefined) return `Version ${snapshot.version}`;
  if (advisory.status === "behind_latest" && advisory.latestVersion !== null) {
    return `New version ${advisory.latestVersion}`;
  }
  if (advisory.status === "current") {
    return `Up to date · checked ${relativeCheck(Date.parse(snapshot.checkedAt), now.getTime())}`;
  }
  return `Version ${snapshot.version}`;
}

function relativeCheck(checkedAtMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - checkedAtMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function providerPriceLine(snapshot: ServerProvider): string {
  const cost = (snapshot as { readonly cost?: { readonly label?: string } }).cost;
  return cost?.label ?? "Price not listed. You'll see the sign-in choices after it's installed.";
}

export function providerSourceLine(snapshot: ServerProvider): string {
  if (snapshot.source === "registry" || snapshot.addedByUser === true) {
    const publisher = snapshot.publisher ?? "the ACP registry";
    const distribution = snapshot.license === null ? "" : ` · ${snapshot.license}`;
    return `ACP registry · ${publisher}${distribution}`;
  }
  return "Built into hbots";
}

/** The saved instance config, falling back to the legacy default blob as the web panel does. */
export function instanceConfigOf(
  settings: Pick<ServerSettings, "providers" | "providerInstances"> | null | undefined,
  instanceId: string,
  driver: ServerProvider["driver"],
): ProviderInstanceConfig | null {
  if (settings === null || settings === undefined) return null;
  const explicit = (
    settings.providerInstances as Record<string, ProviderInstanceConfig> | undefined
  )?.[instanceId];
  if (explicit !== undefined) return explicit;
  if (instanceId !== String(defaultInstanceIdForDriver(driver))) return null;
  const legacy = (settings.providers as Record<string, unknown>)[driver];
  if (legacy === null || typeof legacy !== "object") return null;
  const { enabled, ...config } = legacy as { enabled?: boolean } & Record<string, unknown>;
  return { driver, enabled: enabled ?? false, config } as ProviderInstanceConfig;
}
