import type { PersonalLeadBotChange, PersonalLeadBotChangeStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * A team lead's request to remove or rewrite a bot, in the state the
 * transcript should show it. Unlike connection approvals the server keeps
 * settled rows for a week, so the ending comes from the list itself and this
 * device needs no memory of what it showed.
 *
 * The card carries the whole change because every word the owner reads
 * (`lines`, `reason`) is server-authored from validated values.
 */
export type LeadBotChangeCardItem = {
  readonly kind: PersonalLeadBotChangeStatus;
  readonly changeId: string;
  readonly createdAtMs: number;
  readonly change: PersonalLeadBotChange;
};

/** The cards for one chat, oldest first. */
export function deriveLeadBotChangeCards(
  changes: ReadonlyArray<PersonalLeadBotChange>,
  threadId: string,
): ReadonlyArray<LeadBotChangeCardItem> {
  return changes
    .filter((change) => change.threadId === threadId)
    .map((change) => ({
      kind: change.status,
      changeId: change.changeId as string,
      createdAtMs: DateTime.toEpochMillis(change.createdAt),
      change,
    }))
    .sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs || left.changeId.localeCompare(right.changeId),
    );
}

/**
 * Whether a pending request has run out of time on this device's clock.
 * The server sweeps expiry lazily, so a dead card can still arrive as pending;
 * deciding it would fail, and showing buttons would be a lie.
 */
export function leadBotChangeHasExpired(change: PersonalLeadBotChange, nowMs: number): boolean {
  return DateTime.toEpochMillis(change.expiresAt) <= nowMs;
}

/** Whole minutes left, at least 1 while the request is still live. */
export function leadBotChangeMinutesLeft(change: PersonalLeadBotChange, nowMs: number): number {
  const left = DateTime.toEpochMillis(change.expiresAt) - nowMs;
  return Math.max(1, Math.ceil(left / 60_000));
}
