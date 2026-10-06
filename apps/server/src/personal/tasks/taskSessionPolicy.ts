import {
  PERSONAL_TASK_TERMINAL_STATUSES,
  type OrchestrationSession,
  type PersonalTaskStatus,
} from "@t3tools/contracts";

/** What a task cares to know about a thread's provider session, and about a task's own status. */

/** A session in the middle of a turn: a queued task for its thread waits. */
export const sessionIsBusy = (session: OrchestrationSession | null | undefined) =>
  session?.status === "running" || session?.status === "starting";

/** A session that still has a provider process behind it. */
export const sessionIsAlive = (session: OrchestrationSession | null | undefined) =>
  session !== null &&
  session !== undefined &&
  session.status !== "stopped" &&
  session.status !== "error";

export const isTerminal = (status: PersonalTaskStatus) =>
  PERSONAL_TASK_TERMINAL_STATUSES.includes(status);

/** A task parked until the user (a form, a card) or the shared browser hands it back. */
export const isWaitingForUser = (status: PersonalTaskStatus) =>
  status === "waiting_for_user" || status === "waiting_for_browser";
