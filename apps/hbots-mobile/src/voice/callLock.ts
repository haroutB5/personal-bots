import type { CallView } from "./callSession";

export interface LockCallLine {
  readonly title: string;
  readonly body: string;
}

/**
 * What the app lock shows while a call runs. The call keeps going behind the
 * lock, so this says so and offers Hang up. It never carries the bot's name, a
 * caption or any chat content.
 */
export function lockCallLine(view: CallView): LockCallLine | null {
  const call = view.call;
  if (call === null) return null;
  const status = view.snapshot.state.status;
  if (status === "error" || status === "ended") return null;
  return {
    title: "Call in progress",
    body: view.held ? "The call is paused." : "Your call keeps going. Unlock to see it.",
  };
}
