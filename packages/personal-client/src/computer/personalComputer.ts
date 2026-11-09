import type {
  EnvironmentId,
  PersonalBrowserFilesResult,
  PersonalDesktopActivityEvent,
  PersonalDesktopStatus,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";
import { useMemo } from "react";

import type { PersonalClient } from "../client.ts";
import type { EnvironmentQueryView } from "../react/query.ts";
import { EMPTY_COMPUTER_FEED, reduceComputerFeed, type ComputerFeed } from "./computerModel.ts";
import { EMPTY_DESKTOP_EVENTS, reduceDesktopEvents, type DesktopAccess } from "./desktopModel.ts";
import { PERSONAL_BROWSER_ROUTE_BASE } from "./computerModel.ts";

/**
 * The Computer tab's RPCs, shared by web and phone. The live-view sockets are
 * separate: the web draws JPEG frames on a canvas, the phone hands them to the
 * Kotlin module, and both mint the same short-lived `wsTicket`.
 */
export function createPersonalComputerClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const personalBrowserActivity = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-computer:browser-activity",
    tag: WS_METHODS.personalBrowserActivity,
    transform: (stream) => stream.pipe(Stream.scan(() => EMPTY_COMPUTER_FEED, reduceComputerFeed)),
  });

  const personalBrowserListFiles = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-computer:browser-files",
    tag: WS_METHODS.personalBrowserListFiles,
    staleTimeMs: 5_000,
  });

  const personalBrowserTakeControl = createEnvironmentRpcCommand(runtime, {
    label: "personal-computer:browser-take-control",
    tag: WS_METHODS.personalBrowserTakeControl,
  });

  const personalBrowserReturnToAgent = createEnvironmentRpcCommand(runtime, {
    label: "personal-computer:browser-return-to-agent",
    tag: WS_METHODS.personalBrowserReturnToAgent,
  });

  const personalBrowserClose = createEnvironmentRpcCommand(runtime, {
    label: "personal-computer:browser-close",
    tag: WS_METHODS.personalBrowserClose,
  });

  const personalBrowserApproveEgress = createEnvironmentRpcCommand(runtime, {
    label: "personal-computer:browser-approve-egress",
    tag: WS_METHODS.personalBrowserApproveEgress,
  });

  const personalBrowserRefuseEgress = createEnvironmentRpcCommand(runtime, {
    label: "personal-computer:browser-refuse-egress",
    tag: WS_METHODS.personalBrowserRefuseEgress,
  });

  const personalDesktopStatus = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-computer:desktop-status",
    tag: WS_METHODS.personalDesktopStatus,
  });

  const personalDesktopStop = createEnvironmentRpcCommand(runtime, {
    label: "personal-computer:desktop-stop",
    tag: WS_METHODS.personalDesktopStop,
  });

  const personalDesktopActivity = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-computer:desktop-activity",
    tag: WS_METHODS.personalDesktopActivity,
    transform: (stream) =>
      stream.pipe(Stream.scan(() => EMPTY_DESKTOP_EVENTS, reduceDesktopEvents)),
  });

  function useComputerFeed(environmentId: EnvironmentId | null): {
    readonly feed: ComputerFeed;
    readonly error: string | null;
    readonly loading: boolean;
  } {
    const atom = useMemo(
      () => (environmentId === null ? null : personalBrowserActivity({ environmentId, input: {} })),
      [environmentId],
    );
    const query = client.useEnvironmentQuery(atom);
    return {
      feed: query.data ?? EMPTY_COMPUTER_FEED,
      error: query.error,
      loading: query.data === null && query.error === null,
    };
  }

  function useComputerFiles(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalBrowserFilesResult> {
    const atom = useMemo(
      () =>
        environmentId === null ? null : personalBrowserListFiles({ environmentId, input: {} }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useDesktopStatus(environmentId: EnvironmentId | null): PersonalDesktopStatus | null {
    const atom = useMemo(
      () => (environmentId === null ? null : personalDesktopStatus({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom).data;
  }

  function useDesktopActivity(
    environmentId: EnvironmentId | null,
  ): ReadonlyArray<PersonalDesktopActivityEvent> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalDesktopActivity({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom).data ?? EMPTY_DESKTOP_EVENTS;
  }

  return {
    personalBrowserActivity,
    personalBrowserListFiles,
    personalBrowserTakeControl,
    personalBrowserReturnToAgent,
    personalBrowserClose,
    personalBrowserApproveEgress,
    personalBrowserRefuseEgress,
    personalDesktopStatus,
    personalDesktopStop,
    personalDesktopActivity,
    useComputerFeed,
    useComputerFiles,
    useDesktopStatus,
    useDesktopActivity,
  };
}

export type PersonalComputerClient = ReturnType<typeof createPersonalComputerClient>;

/** The browser viewport socket, from the same access the app's other sockets use. */
export function browserStreamUrl(access: DesktopAccess): string | null {
  if (!access.wsBase.endsWith(PERSONAL_BROWSER_ROUTE_BASE)) return null;
  return `${access.wsBase}/stream${querySuffix(access.query)}`;
}

function querySuffix(query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries).toString()}`;
}
