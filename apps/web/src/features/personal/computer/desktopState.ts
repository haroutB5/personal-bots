import { useMemo } from "react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type PersonalDesktopStatus } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";

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
