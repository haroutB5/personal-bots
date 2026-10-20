import { useCallback, useMemo } from "react";

import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { buildProviderInstanceUpdatePatch } from "~/components/settings/SettingsPanels.logic";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";

/**
 * The instance's saved config. The default slot of a built-in provider may live
 * only in the legacy `settings.providers` blob (no explicit instance yet), the
 * same fallback the desktop provider panel uses; the envelope's `enabled` is
 * then the legacy flag.
 */
export function resolveInstanceConfig(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
): { readonly instance: ProviderInstanceConfig; readonly isDefault: boolean } | null {
  const isDefault = String(instanceId) === String(defaultInstanceIdForDriver(driver));
  const explicit = settings.providerInstances?.[instanceId];
  if (explicit !== undefined) return { instance: explicit, isDefault };
  if (!isDefault) return null;
  const legacy = (settings.providers as Record<string, unknown>)[driver];
  if (legacy === undefined || legacy === null || typeof legacy !== "object") return null;
  const { enabled, ...config } = legacy as { enabled?: boolean } & Record<string, unknown>;
  return {
    instance: { driver, enabled: enabled ?? false, config } as ProviderInstanceConfig,
    isDefault,
  };
}

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
  const resolved = useMemo(
    () => resolveInstanceConfig(settings, instanceId, driver),
    [settings, instanceId, driver],
  );

  const write = useCallback(
    (next: ProviderInstanceConfig, isDefault: boolean) => {
      updateSettings(
        buildProviderInstanceUpdatePatch({
          settings,
          instanceId,
          instance: next,
          driver,
          isDefault,
        }),
      );
    },
    [driver, instanceId, settings, updateSettings],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (resolved === null) return;
      write({ ...resolved.instance, enabled }, resolved.isDefault);
    },
    [resolved, write],
  );
  const setEnvironment = useCallback(
    (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>, enabled?: boolean) => {
      const base: ProviderInstanceConfig =
        resolved?.instance ?? ({ driver } as ProviderInstanceConfig);
      write(
        { ...base, ...(enabled === undefined ? {} : { enabled }), environment: [...environment] },
        resolved?.isDefault ?? String(instanceId) === String(defaultInstanceIdForDriver(driver)),
      );
    },
    [driver, instanceId, resolved, write],
  );
  const setConfig = useCallback(
    (patch: Record<string, unknown>) => {
      const base: ProviderInstanceConfig =
        resolved?.instance ?? ({ driver } as ProviderInstanceConfig);
      const config = { ...(base.config as Record<string, unknown> | undefined), ...patch };
      for (const key of Object.keys(config)) {
        if (config[key] === undefined) delete config[key];
      }
      write(
        { ...base, config } as ProviderInstanceConfig,
        resolved?.isDefault ?? String(instanceId) === String(defaultInstanceIdForDriver(driver)),
      );
    },
    [driver, instanceId, resolved, write],
  );

  return { instance: resolved?.instance ?? null, setEnabled, setEnvironment, setConfig };
}
