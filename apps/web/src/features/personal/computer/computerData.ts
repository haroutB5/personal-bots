import type {
  EnvironmentId,
  PersonalDesktopActivityEvent,
  PersonalDesktopStatus,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import { computerEnvironment, useComputerFeed } from "./computerState";
import type { ComputerFeed } from "./computerModel";
import { desktopEnvironment, useDesktopActivity, useDesktopStatus } from "./desktopState";

/**
 * Everything the Computer tab asks the server. A command resolves to the
 * failure message, or null when it worked, so the screen can say why.
 */
export interface ComputerCommands {
  readonly takeBrowser: () => Promise<string | null>;
  readonly returnBrowser: () => Promise<string | null>;
  readonly closeBrowser: () => Promise<string | null>;
  readonly stopDesktop: () => Promise<string | null>;
  /**
   * Allow once / Refuse for a sensitive-site pause. `available` is false when
   * the server has no such commands; the card then keeps the Take control path.
   */
  readonly egress: {
    readonly available: boolean;
    readonly approve: (threadId: string) => Promise<string | null>;
    readonly refuse: (threadId: string) => Promise<string | null>;
  };
}

export interface ComputerData {
  readonly feed: ComputerFeed;
  readonly error: string | null;
  readonly loading: boolean;
  readonly desktop: PersonalDesktopStatus | null;
  /** The desktop's own activity timeline; merged with the browser's by the screen. */
  readonly desktopEvents: ReadonlyArray<PersonalDesktopActivityEvent>;
  readonly commands: ComputerCommands;
}

const NOT_YET = "The computer isn't ready for that yet.";

export function useComputerData(environmentId: EnvironmentId | null): ComputerData {
  const { feed, error, loading } = useComputerFeed(environmentId);
  const desktop = useDesktopStatus(environmentId);
  const desktopEvents = useDesktopActivity(environmentId);
  const takeControl = useAtomCommand(computerEnvironment.takeControl);
  const returnToAgent = useAtomCommand(computerEnvironment.returnToAgent);
  const closeBrowser = useAtomCommand(computerEnvironment.close);
  const stopDesktop = useAtomCommand(desktopEnvironment.stop);
  const approveEgress = useAtomCommand(computerEnvironment.approveEgress);
  const refuseEgress = useAtomCommand(computerEnvironment.refuseEgress);

  const run = useCallback(
    async (
      command: (value: {
        environmentId: EnvironmentId;
        input: Record<string, never>;
      }) => Promise<Parameters<typeof commandFailureMessage>[0]>,
      fallback: string,
    ): Promise<string | null> => {
      if (environmentId === null) return NOT_YET;
      return commandFailureMessage(await command({ environmentId, input: {} }), fallback);
    },
    [environmentId],
  );

  const decideEgress = useCallback(
    async (
      command: (value: {
        environmentId: EnvironmentId;
        input: { threadId: ThreadId };
      }) => Promise<Parameters<typeof commandFailureMessage>[0]>,
      threadId: string,
      fallback: string,
    ): Promise<string | null> => {
      if (environmentId === null) return NOT_YET;
      return commandFailureMessage(
        await command({ environmentId, input: { threadId: threadId as ThreadId } }),
        fallback,
      );
    },
    [environmentId],
  );

  const commands = useMemo<ComputerCommands>(
    () => ({
      takeBrowser: () => run(takeControl, "Couldn't take control. Try again."),
      returnBrowser: () => run(returnToAgent, "Couldn't hand back. Try again."),
      closeBrowser: () => run(closeBrowser, "Couldn't close the browser. Try again."),
      stopDesktop: () => run(stopDesktop, "Couldn't stop it. Try again."),
      egress: {
        available: true,
        approve: (threadId) =>
          decideEgress(approveEgress, threadId, "Couldn't allow it. Try again."),
        refuse: (threadId) =>
          decideEgress(refuseEgress, threadId, "Couldn't refuse it. Try again."),
      },
    }),
    [
      run,
      decideEgress,
      takeControl,
      returnToAgent,
      closeBrowser,
      stopDesktop,
      approveEgress,
      refuseEgress,
    ],
  );

  return useMemo(
    () => ({ feed, error, loading, desktop, desktopEvents, commands }),
    [feed, error, loading, desktop, desktopEvents, commands],
  );
}
