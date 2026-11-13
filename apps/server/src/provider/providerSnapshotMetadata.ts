/**
 * Snapshot fields the drivers do not carry, plus the volatile maintenance
 * state projected onto each provider snapshot.
 */
import type {
  ServerProvider,
  ServerProviderAutoUpdate,
  ServerProviderSmokeCheck,
  ServerProviderUpdateState,
} from "@t3tools/contracts";

export interface BuiltInProviderMetadata {
  readonly catalogId: string;
  readonly source: "builtIn";
  readonly publisher: string;
  readonly license: string;
  readonly openSource: boolean;
}

const metadataFor = (
  driver: string,
  publisher: string,
  license: string,
  openSource: boolean,
): BuiltInProviderMetadata => ({
  catalogId: `builtin:${driver}`,
  source: "builtIn",
  publisher,
  license,
  openSource,
});

const BUILT_IN_PROVIDER_METADATA: Readonly<Record<string, BuiltInProviderMetadata>> = {
  claudeAgent: metadataFor("claudeAgent", "Anthropic", "proprietary", false),
  codex: metadataFor("codex", "OpenAI", "Apache-2.0", true),
  opencode: metadataFor("opencode", "Anomaly", "MIT", true),
  cursor: metadataFor("cursor", "Cursor", "proprietary", false),
  grok: metadataFor("grok", "xAI", "proprietary", false),
  antigravity: metadataFor("antigravity", "Google LLC", "proprietary", false),
  deepseek: metadataFor("deepseek", "DeepSeek", "unknown", false),
};

export function enrichProviderSnapshotMetadata(provider: ServerProvider): ServerProvider {
  const metadata = BUILT_IN_PROVIDER_METADATA[provider.driver];
  return {
    ...provider,
    ...(provider.catalogId === undefined && metadata !== undefined
      ? { catalogId: metadata.catalogId }
      : {}),
    ...(provider.source === undefined && metadata !== undefined ? { source: metadata.source } : {}),
    ...(provider.publisher === undefined && metadata !== undefined
      ? { publisher: metadata.publisher }
      : {}),
    ...(provider.license === undefined && metadata !== undefined
      ? { license: metadata.license }
      : {}),
    ...(provider.openSource === undefined && metadata !== undefined
      ? { openSource: metadata.openSource }
      : {}),
    showUsage: provider.showUsage ?? true,
  };
}

export interface ProviderMaintenanceActionStates {
  update?: ServerProviderUpdateState | undefined;
  /** The version the running or last update was asked to install. */
  targetVersion?: string | undefined;
  smokeCheck?: ServerProviderSmokeCheck | undefined;
  autoUpdate?: ServerProviderAutoUpdate | undefined;
}

/**
 * One provider snapshot with the volatile action state applied. State the
 * registry does not hold is removed, so a driver or cache value cannot leak
 * a stale verdict.
 */
export function applyProviderMaintenanceActionStates(
  provider: ServerProvider,
  states: ProviderMaintenanceActionStates | undefined,
  options: { readonly canTest?: boolean } = {},
): ServerProvider {
  const {
    updateState: _updateState,
    smokeCheck: _smokeCheck,
    autoUpdate: _autoUpdate,
    ...providerWithoutActionState
  } = provider;
  const canTest = options.canTest === true;
  const setup =
    provider.setup !== undefined || canTest
      ? {
          canAuthenticate: provider.setup?.canAuthenticate ?? false,
          canInstall: provider.setup?.canInstall ?? false,
          ...(provider.setup?.canRemove !== undefined
            ? { canRemove: provider.setup.canRemove }
            : {}),
          canTest,
          ...(provider.setup?.documentationUrl !== undefined
            ? { documentationUrl: provider.setup.documentationUrl }
            : {}),
        }
      : undefined;
  const previousVersion = states?.smokeCheck?.previousVersion ?? provider.previousVersion;
  return {
    ...providerWithoutActionState,
    ...(setup !== undefined ? { setup } : {}),
    ...(previousVersion !== undefined ? { previousVersion } : {}),
    ...(states?.update ? { updateState: states.update } : {}),
    ...(states?.smokeCheck ? { smokeCheck: states.smokeCheck } : {}),
    ...(states?.autoUpdate ? { autoUpdate: states.autoUpdate } : {}),
  };
}
