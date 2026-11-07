import type { EnvironmentId, PersonalPushTestInput } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import type { PersonalClient } from "../client.ts";

/** Push settings shared by web and phone: which events notify. */
export function createPersonalSettingsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
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

  return {
    pushSettings,
    personalPushTest,
    personalPushSetPreferences,
    usePushSettings,
    useSendTestNotification,
    useSavePushPreferences,
  };
}

export type PersonalSettingsClient = ReturnType<typeof createPersonalSettingsClient>;
