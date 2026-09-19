import type { JSX } from "react";

import type { PersonalBot } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";

/** Members shown before the overflow counter takes over. */
const MAX_FACES = 3;

/**
 * A group's face: up to three member avatars overlapped, then "+N".
 *
 * Deliberately not a group avatar of its own (§1.2, [Grok: subtraction]) —
 * a group is its members, and a picked icon would be one more thing to choose
 * and one more thing to keep true when the membership changes.
 */
export function GroupAvatarCluster({
  bots,
  memberCount,
  size,
  className,
}: {
  /** Member bots in sort order; only the first three are drawn. */
  readonly bots: ReadonlyArray<PersonalBot>;
  /**
   * Members in the group, including any whose bot record has not loaded. The
   * counter counts those too, so "+N" is never a lie about group size.
   */
  readonly memberCount: number;
  /** Diameter of one face; the cluster is narrower because the faces overlap. */
  readonly size: number;
  readonly className?: string;
}): JSX.Element {
  const faces = bots.slice(0, MAX_FACES);
  const overflow = memberCount - faces.length;
  // A third of a face of overlap: enough to read as one object, not so much
  // that the bot behind becomes unrecognisable.
  const overlap = Math.round(size / 3);
  const badge = Math.round(size * 0.62);
  return (
    <span
      className={cn("flex shrink-0 items-center", className)}
      style={{ paddingLeft: faces.length > 1 ? overlap : 0 }}
    >
      {faces.map((bot) => (
        <span key={bot.botId} className="rounded-full" style={{ marginLeft: -overlap }}>
          <BotAvatar
            shape={bot.avatarShape}
            color={bot.avatarColor}
            size={size}
            label={bot.name}
            className="ring-2 ring-[var(--personal-bg)]"
          />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          aria-label={`and ${overflow} more`}
          className="flex shrink-0 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)] ring-2 ring-[var(--personal-bg)]"
          style={{
            width: badge,
            height: badge,
            marginLeft: -overlap,
            fontSize: Math.round(badge * 0.42),
          }}
        >
          +{overflow}
        </span>
      ) : null}
      {faces.length === 0 && overflow <= 0 ? (
        <span
          aria-hidden="true"
          className="shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
          style={{ width: size, height: size }}
        />
      ) : null}
    </span>
  );
}
