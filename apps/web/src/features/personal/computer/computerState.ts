import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "~/state/query";
import { environmentSession } from "~/state/session";

import {
  EMPTY_COMPUTER_FEED,
  PERSONAL_BROWSER_ROUTE_BASE,
  reduceComputerFeed,
  type ComputerFeed,
} from "./computerModel";

export const computerEnvironment = {
  /** Recent activity + live status, folded into one view model. */
  feed: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:personal-browser:feed",
    tag: WS_METHODS.personalBrowserActivity,
    transform: (stream) => stream.pipe(Stream.scan(EMPTY_COMPUTER_FEED, reduceComputerFeed)),
  }),
  files: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:personal-browser:files",
    tag: WS_METHODS.personalBrowserListFiles,
  }),
  takeControl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:personal-browser:take-control",
    tag: WS_METHODS.personalBrowserTakeControl,
  }),
  returnToAgent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:personal-browser:return-to-agent",
    tag: WS_METHODS.personalBrowserReturnToAgent,
  }),
};

export function useComputerFeed(environmentId: EnvironmentId | null): {
  readonly feed: ComputerFeed;
  readonly error: string | null;
  readonly loading: boolean;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : computerEnvironment.feed({ environmentId, input: {} }),
  );
  return {
    feed: query.data ?? EMPTY_COMPUTER_FEED,
    error: query.error,
    loading: query.data === null && query.error === null,
  };
}

/**
 * Credentials for the viewport socket and file downloads. Same mechanism as
 * the Device panel: cookie sessions send the cookie, bearer/DPoP connections
 * mint a short-lived `wsTicket`. Refreshed when a socket is refused.
 */
const computerAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: PERSONAL_BROWSER_ROUTE_BASE });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`personal-browser-access:${environmentId}`)),
);

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("personal-browser-access:empty"),
);

export function useComputerAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : computerAccessAtom(environmentId),
  );
  return useMemo(() => (AsyncResult.isSuccess(result) ? result.value : null), [result]);
}

export function refreshComputerAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(computerAccessAtom(environmentId));
}

export const viewportStreamUrl = (access: DeviceHubAccess) =>
  withDeviceHubQuery(`${access.wsBase}/stream`, access);

export const fileDownloadUrl = (access: DeviceHubAccess, fileId: string) =>
  withDeviceHubQuery(`${access.httpBase}/files/${encodeURIComponent(fileId)}`, access);
