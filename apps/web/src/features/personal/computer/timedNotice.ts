/** How long a refusal ("The site refused the connection…") stays over the live view. */
export const REJECTED_NOTICE_MS = 6_000;

/**
 * A notice that goes away by itself. The laptop answers a failed address with a
 * reason that used to stay over the live view for good, even after the next
 * page loaded fine. `show` keeps the newest reason and removes it after `ms`,
 * but only if it is still the one shown (a FramesHidden notice or a newer
 * refusal in the meantime is left alone); `cancel` stops the pending removal.
 */
export function createTimedNotice(
  set: (update: (current: string | null) => string | null) => void,
  ms: number = REJECTED_NOTICE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const show = (reason: string) => {
    cancel();
    set(() => reason);
    timer = setTimeout(() => {
      timer = undefined;
      set((current) => (current === reason ? null : current));
    }, ms);
  };
  return { show, cancel };
}
