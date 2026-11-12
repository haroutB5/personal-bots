/**
 * The gaming PC under the laptop line: "Gaming PC · CPU 32% · RAM 12/16 GB ·
 * GPU 4%", and a third line "In use: League match, Builder (APK build)" when
 * someone is on it. Same size and colour as the laptop line; a figure turns
 * amber from 90%. Nothing is drawn while the PC is off or the link is starting,
 * and no row is reserved for it. The bot's purpose is in the tooltip and the
 * accessibility label only.
 */
import type { JSX } from "react";
import { Fragment } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { gamingPcAriaLabel, gamingPcParts, gamingPcUsersText, type GamingPc } from "./systemStats";

const LINE =
  "truncate text-[12px] leading-4 font-medium text-[var(--personal-text-secondary)] tabular-nums";

export function GamingPcLines({ pc }: { readonly pc: GamingPc | null }): JSX.Element | null {
  const parts = gamingPcParts(pc);
  if (parts.length === 0) return null;
  const users = gamingPcUsersText(pc);
  const label = gamingPcAriaLabel(pc) ?? undefined;
  return (
    <Tooltip>
      <TooltipTrigger render={<div role="group" aria-label={label} />}>
        <div className={LINE} aria-hidden="true">
          {parts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 ? <span className="px-1">·</span> : null}
              <span className={cn(part.busy && "text-[var(--personal-review-text)]")}>
                {part.text}
              </span>
            </Fragment>
          ))}
        </div>
        {users === null ? null : (
          <div className={LINE} aria-hidden="true">
            {users}
          </div>
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
