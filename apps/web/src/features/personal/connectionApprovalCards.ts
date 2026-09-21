import type { PersonalConnectionApproval } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * What this device did with an approval it showed. `personalConnectionApprovals.list`
 * returns only rows still pending, so a settled card reads its ending from the
 * decision this screen itself sent. An approval that left `pending` without this
 * device answering it — another phone, an expiry, the task being cancelled — is
 * "closed", because this device genuinely does not know which of those happened.
 */
export type ConnectionApprovalOutcome = "approved" | "denied";

/**
 * A gated vendor call waiting on the owner, in the state the transcript should
 * show it.
 *
 * The pending variant carries the whole approval because every word the owner
 * reads — `summary`, `targetResources` — is server-authored from validated
 * arguments. Nothing here is the model's description of what it is about to do.
 */
export type ConnectionApprovalCardItem =
  | {
      readonly kind: "pending";
      readonly approvalId: string;
      readonly createdAtMs: number;
      readonly approval: PersonalConnectionApproval;
    }
  | {
      readonly kind: "approved" | "denied" | "closed";
      readonly approvalId: string;
      readonly createdAtMs: number;
      readonly summary: string;
      readonly vendorId: string;
    };

const createdAtMs = (approval: PersonalConnectionApproval): number =>
  DateTime.toEpochMillis(approval.createdAt);

/**
 * The cards to render for one chat, oldest first.
 *
 * `seen` is every approval this screen has shown. Deciding removes the row from
 * the pending list, and without that memory the card would vanish under the
 * owner's thumb, leaving no record that the bot asked or that they answered.
 */
export function deriveConnectionApprovalCards(
  pending: ReadonlyArray<PersonalConnectionApproval>,
  threadId: string,
  seen: ReadonlyMap<string, PersonalConnectionApproval>,
  outcomes: ReadonlyMap<string, ConnectionApprovalOutcome>,
): ReadonlyArray<ConnectionApprovalCardItem> {
  const forThread = pending.filter((approval) => approval.threadId === threadId);
  const pendingById = new Map(
    forThread.map((approval) => [approval.approvalId as string, approval]),
  );
  const approvals = new Map<string, PersonalConnectionApproval>();
  for (const [approvalId, approval] of seen) {
    if (approval.threadId === threadId) approvals.set(approvalId, approval);
  }
  for (const [approvalId, approval] of pendingById) {
    if (!approvals.has(approvalId)) approvals.set(approvalId, approval);
  }

  const cards: ConnectionApprovalCardItem[] = [];
  for (const [approvalId, approval] of approvals) {
    const live = pendingById.get(approvalId);
    if (live !== undefined) {
      cards.push({ kind: "pending", approvalId, createdAtMs: createdAtMs(live), approval });
      continue;
    }
    cards.push({
      kind: outcomes.get(approvalId) ?? "closed",
      approvalId,
      createdAtMs: createdAtMs(approval),
      summary: approval.summary,
      vendorId: approval.vendorId,
    });
  }
  return cards.sort((left, right) => left.createdAtMs - right.createdAtMs);
}

/**
 * The chats a bot is parked on an approval in, for the bots list's "Needs you"
 * row: a gated call is visible without opening the chat it happened in.
 */
export function threadIdsAwaitingApproval(
  pending: ReadonlyArray<PersonalConnectionApproval>,
): ReadonlySet<string> {
  return new Set(pending.map((approval) => approval.threadId as string));
}

/**
 * Whether a pending approval has run out of time, given the clock now.
 *
 * Expiry is swept lazily on the server, so a card can still be listed as
 * pending after its moment has passed. Deciding it would fail; showing it as
 * live would be a lie. The screen reads this instead.
 */
export function approvalHasExpired(approval: PersonalConnectionApproval, nowMs: number): boolean {
  return DateTime.toEpochMillis(approval.expiresAt) <= nowMs;
}
