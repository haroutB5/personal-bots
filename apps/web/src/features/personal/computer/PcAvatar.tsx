import type { JSX, ReactNode } from "react";

import { cn } from "~/lib/utils";

/*
 * The PC as one of the team (spec section 0.4): a laptop wearing the bots'
 * eyes. Calm: nothing; busy: the existing comet; under strain: the amber ring
 * the "needs you" bots wear; paused: eyes closed; measuring: the thinking
 * cloud is the summary card's own note, the pose stays calm.
 *
 * The comet is handed in by ComputerScreen as `orbit` instead of imported:
 * this file lives in the lazy Performance chunk, and an import of BotAvatar
 * from here makes rolldown hoist shared modules (perfFlags) out of chunks the
 * app loads on every open, costing one more request per open (measured on
 * 1.67.2; `perf:check` request counts pin it). ComputerScreen passes
 * `AvatarOrbitLayer shape="roundedSquare"` so the comet stays one component.
 */

export type PcPose = "calm" | "busy" | "strain" | "paused";

export function PcAvatar({
  pose,
  size = 48,
  className,
  orbit,
}: {
  readonly pose: PcPose;
  readonly size?: number;
  readonly className?: string;
  /** `AvatarOrbitLayer shape="roundedSquare"`, drawn only while busy. */
  readonly orbit?: ReactNode;
}): JSX.Element {
  const closed = pose === "paused";
  const body = "#94A3B8";
  const eye = (cx: number) =>
    closed ? (
      <rect key={cx} x={cx - 7} y={48} width="14" height="4.5" rx="2.25" fill="#111111" />
    ) : (
      <rect
        key={cx}
        x={cx - 4.5}
        y={34}
        width="9"
        height="22"
        rx="4.5"
        fill="#111111"
        transform={`rotate(15 ${cx} 45)`}
      />
    );
  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center",
        pose === "strain" &&
          "rounded-[16px] ring-2 ring-[var(--personal-state-needs,var(--personal-review-text))] ring-offset-2 ring-offset-[var(--personal-surface)]",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg className="bot-avatar" width={size} height={size} viewBox="0 0 100 100">
        <rect x="13" y="18" width="74" height="54" rx="13" fill={body} />
        <rect x="5" y="76" width="90" height="9" rx="4.5" fill={body} />
        {eye(41)}
        {eye(58)}
      </svg>
      {pose === "busy" ? (orbit ?? null) : null}
    </span>
  );
}
