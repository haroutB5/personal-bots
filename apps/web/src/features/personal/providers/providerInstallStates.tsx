import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";

import type {
  EnvironmentId,
  ProviderInstallState,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

/**
 * The install stream of one provider, reported upward. Only providers the app
 * can install itself (`setup.canInstall`) have one; the Settings list and the
 * provider page both need the live phase, and a hook cannot loop over a list,
 * so each watcher renders nothing and hands its state to the parent.
 */
function InstallWatcher({
  environmentId,
  instanceId,
  onState,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onState: (instanceId: string, state: ProviderInstallState | null) => void;
}): null {
  const query = useEnvironmentQuery(
    serverEnvironment.providerInstallState({ environmentId, input: { instanceId } }),
  );
  const data = query.data;
  useEffect(() => {
    onState(instanceId, data);
  }, [data, instanceId, onState]);
  return null;
}

export function useProviderInstallStates(
  environmentId: EnvironmentId | null,
  providers: ReadonlyArray<ServerProvider>,
): {
  readonly installs: ReadonlyMap<string, ProviderInstallState>;
  readonly watchers: JSX.Element | null;
} {
  const [installs, setInstalls] = useState<ReadonlyMap<string, ProviderInstallState>>(
    () => new Map(),
  );
  const onState = useCallback((instanceId: string, state: ProviderInstallState | null) => {
    setInstalls((previous) => {
      if (previous.get(instanceId) === state || (state === null && !previous.has(instanceId))) {
        return previous;
      }
      const next = new Map(previous);
      if (state === null) next.delete(instanceId);
      else next.set(instanceId, state);
      return next;
    });
  }, []);
  const installable = providers.filter((provider) => provider.setup?.canInstall === true);
  const watchers =
    environmentId === null || installable.length === 0 ? null : (
      <>
        {installable.map((provider) => (
          <InstallWatcher
            key={provider.instanceId}
            environmentId={environmentId}
            instanceId={provider.instanceId}
            onState={onState}
          />
        ))}
      </>
    );
  return { installs, watchers };
}
