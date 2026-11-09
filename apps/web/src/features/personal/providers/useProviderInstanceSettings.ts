import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { buildProviderInstanceUpdatePatch } from "~/components/settings/SettingsPanels.logic";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";

export interface ProviderInstanceSettings {
  readonly instance: ProviderInstanceConfig | null;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setEnvironment: (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
    enabled?: boolean,
  ) => void;
  readonly setConfig: (patch: Record<string, unknown>) => void;
}

/**
 * Edits one provider instance's saved settings from the phone: the Use for bots
 * switch, a key in the instance environment (the same sensitive entry the
 * desktop key field writes, so the server keeps redacting it), and config
 * fields such as OpenCode's server address. Writes go through the same patch
 * builder as the desktop panel.
 */
export function useProviderInstanceSettings(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
): ProviderInstanceSettings {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const instance = settings.providerInstances?.[instanceId] ?? null;

  const write = (next: ProviderInstanceConfig) => {
    updateSettings(buildProviderInstanceUpdatePatch({ settings, instanceId, instance: next }));
  };

  const setEnabled = (enabled: boolean) => {
    if (instance === null) return;
    write({ ...instance, enabled });
  };
  const setEnvironment = (
    environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
    enabled?: boolean,
  ) => {
    const base: ProviderInstanceConfig = instance ?? ({ driver } as ProviderInstanceConfig);
    write({
      ...base,
      ...(enabled === undefined ? {} : { enabled }),
      environment: [...environment],
    });
  };
  const setConfig = (patch: Record<string, unknown>) => {
    const base: ProviderInstanceConfig = instance ?? ({ driver } as ProviderInstanceConfig);
    const config = { ...(base.config as Record<string, unknown> | undefined), ...patch };
    for (const key of Object.keys(config)) {
      if (config[key] === undefined) delete config[key];
    }
    write({ ...base, config } as ProviderInstanceConfig);
  };

  return { instance, setEnabled, setEnvironment, setConfig };
}
