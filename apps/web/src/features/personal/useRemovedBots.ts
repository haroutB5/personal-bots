import type { EnvironmentId, PersonalBotId, PersonalBotRestoreResult } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./commandFeedback";
import { personalBotsList } from "./usePersonalBots";

/**
 * Bots a team lead removed (soft delete: chats, memory and settings kept).
 * Owner only. Nothing pushes a removal, so the list is short-lived and the
 * screen refreshes it on mount.
 */
export const personalRemovedBotsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-bots:removed",
  tag: WS_METHODS.personalBotsListRemoved,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

type Registry = { refresh: (atom: Atom.Atom<unknown>) => void };

/** A restored bot leaves the removed list and joins the main one, so both refresh. */
const refreshBoth = (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
  Effect.sync(() => {
    registry.refresh(personalRemovedBotsList({ environmentId: target.environmentId, input: {} }));
    registry.refresh(personalBotsList({ environmentId: target.environmentId, input: {} }));
  });

export const personalBotRestore = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:restore",
  tag: WS_METHODS.personalBotsRestore,
  onSuccess: refreshBoth,
});

export function useRemovedBots(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalRemovedBotsList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export type RestoreOutcome =
  | { readonly status: "restored"; readonly result: PersonalBotRestoreResult }
  | { readonly status: "failed"; readonly message: string };

/** Brings one removed bot back. A refusal comes back as `failed` with the server's message. */
export function useRestoreRemovedBot(
  environmentId: EnvironmentId | null,
): (botId: PersonalBotId) => Promise<RestoreOutcome> {
  const restore = useAtomCommand(personalBotRestore, { reportFailure: false });
  return useCallback(
    async (botId) => {
      if (environmentId === null) {
        return { status: "failed", message: "Not connected to your computer." };
      }
      const result = await restore({ environmentId, input: { botId } });
      const failure = commandFailureMessage(result, "Couldn't restore this bot. Try again.");
      if (failure !== null || result._tag !== "Success") {
        return { status: "failed", message: failure ?? "Couldn't restore this bot. Try again." };
      }
      return { status: "restored", result: result.value };
    },
    [environmentId, restore],
  );
}
