import type { JSX } from "react";
import { useEffect, useState } from "react";

import { quietNoticeText } from "./chatSilence";

/** A working bot that has sent nothing for a while (`useQuietSince`): who, and since when. */
export interface QuietNotice {
  readonly provider: string;
  readonly sinceMs: number;
}

/**
 * "No response from Claude · 2m", counting from the last output: one muted
 * line directly under the header, where the progress note sits (it replaces
 * it while the bot is quiet). The header's own status shrinks to "No response";
 * the full line has the width for the provider and the timer. It ticks on its
 * own every second, so the screen around it does not re-render. Spoken once,
 * without the timer: a live region that changes every second would drown a
 * screen reader.
 */
export function QuietNoticeLine({ notice }: { notice: QuietNotice }): JSX.Element {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="personal-column shrink-0 px-4 pb-1">
      <span role="status" className="sr-only">
        No response from {notice.provider}
      </span>
      <p
        aria-hidden="true"
        data-testid="quiet-notice"
        className="truncate text-[13px] leading-5 text-[var(--personal-text-tertiary)]"
      >
        {quietNoticeText(notice.provider, nowMs - notice.sinceMs)}
      </p>
    </div>
  );
}
