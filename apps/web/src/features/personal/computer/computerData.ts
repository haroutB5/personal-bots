import type { EnvironmentId, PersonalDesktopStatus } from "@t3tools/contracts";
import { createContext, useCallback, useContext, useMemo } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import { computerEnvironment, useComputerFeed } from "./computerState";
import type { ComputerFeed } from "./computerModel";
import { desktopEnvironment, useDesktopStatus } from "./desktopState";

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
   * Allow once / Refuse for a sensitive-site pause. `available` is false until
   * the server has the commands (Backend SPEC section 10); the card then keeps
   * today's Take control path.
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
  readonly commands: ComputerCommands;
  /** Set only by the mock layer: stages draw a stand-in instead of a socket. */
  readonly mock: string | null;
}

/** The mock layer provides this; absent in production. */
export const ComputerDataOverride = createContext<ComputerData | null>(null);

const NOT_YET = "The computer isn't ready for that yet.";

export function useComputerData(environmentId: EnvironmentId | null): ComputerData {
  const override = useContext(ComputerDataOverride);
  // Under the mock layer no real subscription is opened.
  const liveEnvironment = override === null ? environmentId : null;
  const { feed, error, loading } = useComputerFeed(liveEnvironment);
  const desktop = useDesktopStatus(liveEnvironment);
  const takeControl = useAtomCommand(computerEnvironment.takeControl);
  const returnToAgent = useAtomCommand(computerEnvironment.returnToAgent);
  const closeBrowser = useAtomCommand(computerEnvironment.close);
  const stopDesktop = useAtomCommand(desktopEnvironment.stop);

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

  const commands = useMemo<ComputerCommands>(
    () => ({
      takeBrowser: () => run(takeControl, "Couldn't take control. Try again."),
      returnBrowser: () => run(returnToAgent, "Couldn't hand back. Try again."),
      closeBrowser: () => run(closeBrowser, "Couldn't close the browser. Try again."),
      stopDesktop: () => run(stopDesktop, "Couldn't stop it. Try again."),
      // Swap for real RPCs when Backend's contract lands (approveEgress and
      // refuseEgress); until then the sensitive card keeps Take control.
      egress: {
        available: false,
        approve: () => Promise.resolve(NOT_YET),
        refuse: () => Promise.resolve(NOT_YET),
      },
    }),
    [run, takeControl, returnToAgent, closeBrowser, stopDesktop],
  );

  return useMemo(
    () => override ?? { feed, error, loading, desktop, commands, mock: null },
    [override, feed, error, loading, desktop, commands],
  );
}
