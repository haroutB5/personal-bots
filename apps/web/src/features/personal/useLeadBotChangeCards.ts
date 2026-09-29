import { useMemo, useState } from "react";

import {
  PersonalLeadBotChangeId,
  type EnvironmentId,
  type PersonalLeadBotChange,
} from "@t3tools/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useAtomCommand } from "~/state/use-atom-command";

import { deriveLeadBotChangeCards, type LeadBotChangeCardItem } from "./leadBotChangeCards";
import { personalLeadBotChangeDecide, useLeadBotChangesQuery } from "./useLeadBotChanges";

const EMPTY: ReadonlyArray<PersonalLeadBotChange> = [];

/** The lead-bot change cards for one chat, and the way to answer them. */
export function useLeadBotChangeCards(
  environmentId: EnvironmentId | null,
  threadId: string,
): {
  readonly cards: ReadonlyArray<LeadBotChangeCardItem>;
  readonly respondingIds: ReadonlySet<string>;
  readonly decide: (
    changeId: string,
    changeHash: string,
    decision: "approved" | "declined",
  ) => Promise<string | null>;
} {
  const query = useLeadBotChangesQuery(environmentId);
  const changes = query.data?.changes ?? EMPTY;
  const decideCommand = useAtomCommand(personalLeadBotChangeDecide, { reportFailure: false });
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());

  const cards = useMemo(() => deriveLeadBotChangeCards(changes, threadId), [changes, threadId]);

  /** Resolves to an error message for the card to show, or null when it landed. */
  const decide = async (
    changeId: string,
    changeHash: string,
    decision: "approved" | "declined",
  ) => {
    if (environmentId === null) return null;
    setRespondingIds((current) => new Set(current).add(changeId));
    const result = await decideCommand({
      environmentId,
      input: { changeId: PersonalLeadBotChangeId.make(changeId), changeHash, decision },
    });
    let error: string | null = null;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      error =
        failure instanceof Error ? failure.message : "Couldn't answer this request. Try again.";
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(changeId);
      return next;
    });
    return error;
  };

  return { cards, respondingIds, decide };
}
