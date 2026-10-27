import type {
  EnvironmentId,
  PersonalDesktopActivityEvent,
  PersonalDesktopStatus,
  ThreadId,
} from "@t3tools/contracts";
import { createContext, useCallback, useContext, useMemo } from "react";

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
   * Allow once / Refuse for a sensitive-site pause. `available` is false only
   * under the mock layer when a scenario turns it off; the card then keeps the
   * Take control path.
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
  const desktopEvents = useDesktopActivity(liveEnvironment);
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
    () => override ?? { feed, error, loading, desktop, desktopEvents, commands, mock: null },
    [override, feed, error, loading, desktop, desktopEvents, commands],
  );
}

export const MOCK_STORAGE_KEY = "hbots.computer.mock";

/**
 * The scenario the mock layer plays, from `?computerMock=<name>` or the
 * `hbots.computer.mock` storage key, or null for the real server. Inert unless
 * one of the two is set.
 */
export function readMockScenario(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("computerMock");
    if (fromUrl !== null && fromUrl !== "") return fromUrl;
    const stored = window.localStorage.getItem(MOCK_STORAGE_KEY);
    return stored !== null && stored !== "" ? stored : null;
  } catch {
    return null;
  }
}
