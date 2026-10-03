/**
 * Keeps a slow reply to an earlier tap from undoing what a later tap did.
 *
 * The phone numbers every focus-moving input it sends (a tap, a Tab or Enter
 * press) and the server echoes the number on the focus report that answers it.
 * A tap on a button is answered "no field", and that answer can still be on
 * its way when the next tap lands on a text field and raises the keyboard; if
 * it were acted on it would put the keyboard straight back down. So a report
 * for an input that is no longer the newest is ignored: the newest input's own
 * report is the one that speaks for focus. A report with no number (an older
 * server) is always acted on, as before.
 */
export interface FocusReplyGuard {
  /** The number to put on the next focus-moving input about to be sent. */
  readonly issue: () => number;
  /** Whether a focus report carrying `seq` should still be acted on. */
  readonly accept: (seq: number | undefined) => boolean;
}

export function createFocusReplyGuard(): FocusReplyGuard {
  let issued = 0;
  let applied = 0;
  return {
    issue: () => ++issued,
    accept: (seq) => {
      if (seq === undefined) return true;
      if (seq < issued || seq < applied) return false;
      applied = seq;
      return true;
    },
  };
}
