import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

export const personalDevices = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-devices:list",
  tag: WS_METHODS.personalDevicesList,
  staleTimeMs: 5_000,
});

export const personalDeviceRevoke = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-devices:revoke",
  tag: WS_METHODS.personalDevicesRevoke,
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      registry.refresh(personalDevices({ environmentId: target.environmentId, input: {} }));
    }),
});

export function usePersonalDevices(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalDevices({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
