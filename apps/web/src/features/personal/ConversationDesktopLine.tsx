import { type JSX, useState } from "react";

import type { EnvironmentId, PersonalDesktopStatus } from "@t3tools/contracts";
import { Monitor } from "lucide-react";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { desktopEnvironment, desktopLineFor } from "./computer/desktopState";

/**
 * One quiet line above the composer while this chat's bot holds the user's
 * real PC (with a Stop that works from the phone too), or waits in line for
 * it. Nothing at all otherwise.
 */
export function ConversationDesktopLine({
  environmentId,
  status,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PersonalDesktopStatus | null;
  readonly threadId: string;
}): JSX.Element | null {
  const stop = useAtomCommand(desktopEnvironment.stop);
  const [stopping, setStopping] = useState(false);
  const line = desktopLineFor(status, threadId);
  if (line === null) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 px-4">
      <span
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5 text-[13px]",
          line.kind === "using"
            ? "font-medium text-[var(--personal-review-text)]"
            : "text-[var(--personal-text-secondary)]",
        )}
      >
        <Monitor aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        {line.text}
      </span>
      {line.kind === "using" ? (
        <button
          type="button"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void stop({ environmentId, input: {} }).finally(() => setStopping(false));
          }}
          className={cn(
            "min-h-11 rounded-[var(--personal-radius-button)] px-3 text-[13px] font-medium outline-none",
            "text-[var(--personal-danger)] personal-row-hover active:opacity-70",
            "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50",
          )}
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      ) : null}
    </div>
  );
}
