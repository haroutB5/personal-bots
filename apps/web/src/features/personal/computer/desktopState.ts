import { useMemo } from "react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import {
  PERSONAL_DESKTOP_STREAM_PATH,
  WS_METHODS,
  type EnvironmentId,
  type PersonalDesktopStatus,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";

import { PERSONAL_BROWSER_ROUTE_BASE } from "./computerModel";

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
};

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

/** What a chat's desktop line says, or null when this chat is not on the PC. */
export function desktopLineFor(
  status: PersonalDesktopStatus | null,
  threadId: string,
):
  | { readonly kind: "using"; readonly text: string }
  | { readonly kind: "waiting"; readonly text: string }
  | null {
  if (status === null) return null;
  if (status.holder?.threadId === threadId) {
    return { kind: "using", text: `Using your PC · press ${status.stopHotkey} on the PC to stop` };
  }
  if (status.waiting.some((entry) => entry.threadId === threadId)) {
    return {
      kind: "waiting",
      text:
        status.holder === null
          ? "Waiting for the computer"
          : `Waiting for the computer · ${status.holder.botName} is using it`,
    };
  }
  return null;
}

/**
 * The live view socket's URL, from the Computer tab's own access (same
 * cookie or `wsTicket`, so no second ticket). The access base ends in the
 * browser's route base; the desktop path swaps just that suffix, which keeps
 * any path prefix a relay adds in front.
 */
export function desktopStreamUrl(access: DeviceHubAccess): string | null {
  if (!access.wsBase.endsWith(PERSONAL_BROWSER_ROUTE_BASE)) return null;
  const origin = access.wsBase.slice(0, -PERSONAL_BROWSER_ROUTE_BASE.length);
  return withDeviceHubQuery(`${origin}${PERSONAL_DESKTOP_STREAM_PATH}`, access);
}

/** Who has the PC, for the Desktop view's status line. */
export function desktopHolderLine(status: PersonalDesktopStatus | null): {
  readonly text: string;
  readonly busy: boolean;
} {
  if (status === null) return { text: "Checking the PC", busy: false };
  if (!status.available)
    return { text: "The live view needs the bots server on Windows", busy: false };
  const waiting = status.waiting.length;
  const queue = waiting === 0 ? "" : ` · ${waiting} waiting`;
  if (status.holder !== null) {
    return { text: `${status.holder.botName} is using your PC${queue}`, busy: true };
  }
  return { text: `No bot is using your PC${queue}`, busy: false };
}
