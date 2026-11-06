import type { EnvironmentId, PersonalPushTestInput } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import type { PersonalClient } from "../client.ts";
import type { EnvironmentQueryView } from "../react/query.ts";

/** Push settings shared by web and phone: which events notify, and the devices. */
export function createPersonalSettingsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const pushSettings = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-push:settings",
    tag: WS_METHODS.personalPushGetSettings,
    staleTimeMs: 10_000,
    idleTtlMs: 5 * 60_000,
  });

  const personalPushTest = createEnvironmentRpcCommand(runtime, {
    label: "personal-push:test",
    tag: WS_METHODS.personalPushTest,
  });

  const devices = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-devices:list",
    tag: WS_METHODS.personalDevicesList,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  });

  const revokeDeviceCommand = createEnvironmentRpcCommand(runtime, {
    label: "personal-devices:revoke",
    tag: WS_METHODS.personalDevicesRevoke,
    onSuccess: (target, registry) =>
      Effect.sync(() => {
        registry.refresh(devices({ environmentId: target.environmentId, input: {} }));
      }),
  });

  const personalPushSetPreferences = createEnvironmentRpcCommand(runtime, {
    label: "personal-push:set-preferences",
    tag: WS_METHODS.personalPushSetPreferences,
    onSuccess: (target, registry) =>
      Effect.sync(() => {
        registry.refresh(pushSettings({ environmentId: target.environmentId, input: {} }));
      }),
  });

  function usePushSettings(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : pushSettings({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useSendTestNotification(environmentId: EnvironmentId | null) {
    const send = client.useAtomCommand(personalPushTest, { reportFailure: false });
    return useCallback(
      async (input: PersonalPushTestInput = {}) => {
        if (environmentId === null) return null;
        return send({ environmentId, input });
      },
      [environmentId, send],
    );
  }

  function useSavePushPreferences(environmentId: EnvironmentId | null) {
    const save = client.useAtomCommand(personalPushSetPreferences, { reportFailure: false });
    return useCallback(
      async (preferences: Parameters<typeof save>[0]["input"]) => {
        if (environmentId === null) return null;
        return save({ environmentId, input: preferences });
      },
      [environmentId, save],
    );
  }

  function useDevices(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : devices({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useRevokeDevice(environmentId: EnvironmentId | null) {
    const revoke = client.useAtomCommand(revokeDeviceCommand, { reportFailure: false });
    return useCallback(
      async (sessionId: Parameters<typeof revoke>[0]["input"]["sessionId"]) => {
        if (environmentId === null) return null;
        return revoke({ environmentId, input: { sessionId } });
      },
      [environmentId, revoke],
    );
  }

  return {
    pushSettings,
    personalPushTest,
    personalPushSetPreferences,
    devices,
    revokeDevice: revokeDeviceCommand,
    usePushSettings,
    useSendTestNotification,
    useSavePushPreferences,
    useDevices,
    useRevokeDevice,
  };
}

export type PersonalSettingsClient = ReturnType<typeof createPersonalSettingsClient>;
