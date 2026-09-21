import { useMemo, useState } from "react";

import {
  PersonalConnectionApprovalId,
  type EnvironmentId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useAtomCommand } from "~/state/use-atom-command";

import {
  deriveConnectionApprovalCards,
  type ConnectionApprovalCardItem,
  type ConnectionApprovalOutcome,
} from "./connectionApprovalCards";
import {
  personalConnectionApprovalDecide,
  usePendingConnectionApprovals,
} from "./useConnectionApprovals";

const EMPTY: ReadonlyArray<PersonalConnectionApproval> = [];

/**
 * The approval cards for one chat, and the way to answer them.
 *
 * Shared by the one-to-one and group screens rather than written twice: a bot
 * in a group reaches the same gateway, and a screen that could show the ask but
 * not answer it would park the task for ever exactly as having no card at all
 * did.
 */
export function useConnectionApprovalCards(
  environmentId: EnvironmentId | null,
  threadId: string,
): {
  readonly cards: ReadonlyArray<ConnectionApprovalCardItem>;
  readonly respondingIds: ReadonlySet<string>;
  readonly decide: (approvalId: string, decision: "approved" | "denied") => Promise<string | null>;
} {
  const query = usePendingConnectionApprovals(environmentId);
  const pending = query.data?.approvals ?? EMPTY;
  const decideCommand = useAtomCommand(personalConnectionApprovalDecide, { reportFailure: false });

  // The server drops a row the moment it is decided. Without this memory the
  // card would vanish under the owner's thumb, leaving no record either way.
  const [seen, setSeen] = useState<ReadonlyMap<string, PersonalConnectionApproval>>(
    () => new Map(),
  );
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, ConnectionApprovalOutcome>>(
    () => new Map(),
  );
  const [respondingIds, setRespondingIds] = useState<ReadonlySet<string>>(() => new Set());

  if (pending.some((approval) => !seen.has(approval.approvalId))) {
    const next = new Map(seen);
    for (const approval of pending) next.set(approval.approvalId, approval);
    setSeen(next);
  }

  const cards = useMemo(
    () => deriveConnectionApprovalCards(pending, threadId, seen, outcomes),
    [outcomes, pending, seen, threadId],
  );

  /** Resolves to an error message for the screen to show, or null when it landed. */
  const decide = async (approvalId: string, decision: "approved" | "denied") => {
    if (environmentId === null) return null;
    setRespondingIds((current) => new Set(current).add(approvalId));
    const result = await decideCommand({
      environmentId,
      input: { approvalId: PersonalConnectionApprovalId.make(approvalId), decision },
    });
    let error: string | null = null;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      error =
        failure instanceof Error ? failure.message : "Couldn't answer this request. Try again.";
    } else {
      setOutcomes((current) => new Map(current).set(approvalId, decision));
    }
    setRespondingIds((current) => {
      const next = new Set(current);
      next.delete(approvalId);
      return next;
    });
    return error;
  };

  return { cards, respondingIds, decide };
}
