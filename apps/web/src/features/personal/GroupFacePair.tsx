import type { JSX } from "react";

import type { PersonalBot } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";

/**
 * A group row's face, as the design draws it: a 48 box with two 32 avatars,
 * one at the top-left and one at the bottom-right. The front avatar carries a
 * background-coloured outline of its own silhouette (`.group-face-front` in
 * personal.css), so it cuts cleanly out of the face behind it.
 *
 * The bigger three-face cluster (`GroupAvatarCluster`) stays as it is for the
 * places drawn for it; this pair is what a 48 px chat row shows, per the spec.
 */
export function GroupFacePair({
  bots,
  className,
}: {
  /** Member bots in sort order; only the first two are drawn. */
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly className?: string | undefined;
}): JSX.Element {
  const [back, front] = bots;
  const size = 32;
  return (
    <span aria-hidden="true" className={cn("relative block size-12 shrink-0", className)}>
      {back !== undefined ? (
        <span className="absolute top-0 left-0">
          <BotAvatar
            shape={back.avatarShape}
            color={back.avatarColor}
            size={size}
            label={back.name}
          />
        </span>
      ) : null}
      {front !== undefined ? (
        <span className="group-face-front">
          <BotAvatar
            shape={front.avatarShape}
            color={front.avatarColor}
            size={size}
            label={front.name}
          />
        </span>
      ) : null}
    </span>
  );
}
