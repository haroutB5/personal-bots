import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";
import type { BotShellMap } from "@hbots/personal-client/bots/shellStream";
import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";

import { useArchivedThreadShells } from "~/state/lazyThreadShells";

import { usePersonalBotShells } from "./usePersonalBots";

const NO_SHELLS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);

/**
 * The open chats from the shell stream, then the asked-for archived chats the
 * stream lacks. A chat in both keeps its stream shell, which stays current.
 */
export function mergeBotShells(
  environmentId: EnvironmentId,
  open: BotShellMap | null,
  archived: ReadonlyArray<ReadonlyArray<OrchestrationThreadShell>>,
): ReadonlyArray<EnvironmentThreadShell> {
  const shells: EnvironmentThreadShell[] = [];
  const seen = new Set<string>();
  const add = (thread: OrchestrationThreadShell) => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    shells.push({ ...thread, environmentId });
  };
  for (const thread of open?.values() ?? []) add(thread);
  for (const threads of archived) for (const thread of threads) add(thread);
  return shells;
}

/**
 * Every bot chat the web personal screens know: the live shell stream's open
 * chats plus the archived ones a mounted screen asked for with
 * useLazyThreadShells. Empty until the stream's snapshot lands.
 */
export function useBotShells(
  environmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentThreadShell> {
  const open = usePersonalBotShells(environmentId).data;
  const archived = useArchivedThreadShells(environmentId);
  return environmentId === null ? NO_SHELLS : mergeBotShells(environmentId, open, archived);
}

/** One chat's shell from useBotShells, or null until it is known. */
export function useBotShell(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): EnvironmentThreadShell | null {
  const shells = useBotShells(environmentId);
  return threadId === null ? null : (shells.find((shell) => shell.id === threadId) ?? null);
}
