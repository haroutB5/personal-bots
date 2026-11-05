import {
  PERSONAL_DESKTOP_STREAM_PATH,
  WS_METHODS,
  type EnvironmentId,
  type PersonalDesktopActivityEvent,
  type PersonalDesktopStatus,
} from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  EMPTY_DESKTOP_EVENTS,
  desktopStreamUrl as sharedDesktopStreamUrl,
  reduceDesktopEvents,
} from "@hbots/personal-client/computer/desktopModel";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import { useMemo } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";

import { PERSONAL_BROWSER_ROUTE_BASE } from "./computerModel";

export {
  EMPTY_DESKTOP_EVENTS,
  desktopHolderLine,
  desktopLineFor,
  reduceDesktopEvents,
} from "@hbots/personal-client/computer/desktopModel";

/** The user's real PC: who holds it, who waits, and the app's Stop. */
export const desktopEnvironment = {
  status: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:personal-desktop:status",
    tag: WS_METHODS.personalDesktopStatus,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:personal-desktop:stop",
    tag: WS_METHODS.personalDesktopStop,
  }),
  /** What bots did on the desktop: recent history, then live events. */
  activity: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:personal-desktop:activity",
    tag: WS_METHODS.personalDesktopActivity,
    transform: (stream) => stream.pipe(Stream.scan(EMPTY_DESKTOP_EVENTS, reduceDesktopEvents)),
  }),
};

export function useDesktopActivity(
  environmentId: EnvironmentId | null,
): ReadonlyArray<PersonalDesktopActivityEvent> {
  const query = useEnvironmentQuery(
    environmentId === null ? null : desktopEnvironment.activity({ environmentId, input: {} }),
  );
  return query.data ?? EMPTY_DESKTOP_EVENTS;
}

export function useDesktopStatus(
  environmentId: EnvironmentId | null,
): PersonalDesktopStatus | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : desktopEnvironment.status({ environmentId, input: {} }),
  );
  return query.data ?? null;
}

/** The shape `buildBotSummaries` takes. */
export function useDesktopSummaryInput(status: PersonalDesktopStatus | null): {
  readonly holderThreadId: string | null;
  readonly waitingThreadIds: ReadonlySet<string>;
} | null {
  return useMemo(
    () =>
      status === null
        ? null
        : {
            holderThreadId: status.holder?.threadId ?? null,
            waitingThreadIds: new Set(status.waiting.map((entry) => entry.threadId)),
          },
    [status],
  );
}

/** The live view socket's URL, from the Computer tab's own access. */
export function desktopStreamUrl(access: DeviceHubAccess): string | null {
  return sharedDesktopStreamUrl(access, PERSONAL_BROWSER_ROUTE_BASE, PERSONAL_DESKTOP_STREAM_PATH);
}
