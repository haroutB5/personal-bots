import { useCallback, useMemo, useState } from "react";

import type { EnvironmentId, PersonalMemoryCard } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { deriveMemoryCards, type MemoryCardItem } from "./memoryCards";
import { personalMemoryCards, personalMemoryTidyDecide } from "./usePersonalAutomation";
import { usePersonalBotsList } from "./usePersonalBots";

const EMPTY: ReadonlyArray<PersonalMemoryCard> = [];

/** The memory cards for one chat, bot names for their headers, and the way to answer them. */
export function useMemoryCards(
  environmentId: EnvironmentId | null,
  threadId: string,
): {
  readonly cards: ReadonlyArray<MemoryCardItem>;
  readonly respondingIds: ReadonlySet<number>;
  readonly botName: (botId: string) => string | undefined;
  readonly decide: (
    changeId: number,
    changeHash: string,
    approve: boolean,
  ) => Promise<string | null>;
} {
  const atom = useMemo(
    () =>
      environmentId === null || threadId.trim() === ""
        ? null
        : personalMemoryCards({ environmentId, input: { threadId } }),
    [environmentId, threadId],
  );
  const query = useEnvironmentQuery(atom);
  const bots = usePersonalBotsList(environmentId);
  // The decide command refreshes the memory lists and the tidy-up log itself.
  const decideCommand = useAtomCommand(personalMemoryTidyDecide, { reportFailure: false });
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<number>>(() => new Set());

  const raw = query.data?.cards ?? EMPTY;
  const cards = useMemo(() => deriveMemoryCards(raw, threadId), [raw, threadId]);
  const names = useMemo(
    () => new Map((bots.data?.bots ?? []).map((bot) => [bot.botId as string, bot.name])),
    [bots.data],
  );
  const botName = useCallback((botId: string) => names.get(botId), [names]);

  /** Resolves to an error message for the card to show, or null when it landed. */
  const decide = async (changeId: number, changeHash: string, approve: boolean) => {
    if (environmentId === null) return null;
    setRespondingIds((current) => new Set(current).add(changeId));
    const result = await decideCommand({
      environmentId,
      input: { changeId, approve, changeHash },
    });
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(changeId);
      return next;
    });
    // A stale card is refused: refresh either way so it shows what is true now.
    query.refresh();
    if (isAtomCommandInterrupted(result)) return null;
    return commandFailureMessage(result, "Couldn't answer this request. Try again.");
  };

  return { cards, respondingIds, botName, decide };
}
