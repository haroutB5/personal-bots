import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { unreadChatsLabel } from "./unreadChats";

/**
 * The count of a bot's unread chats, in the Settings badge's shape (1.60.22)
 * a size smaller so it sits in the row's 20 px status line. Speaks
 * "2 unread chats"; the digits alone are hidden from assistive tech.
 */
export function UnreadChatsBadge({
  count,
  className,
}: {
  readonly count: number;
  readonly className?: string | undefined;
}): JSX.Element {
  return (
    <span data-testid="unread-chats-badge" className={cn("flex shrink-0 items-center", className)}>
      <span
        aria-hidden="true"
        className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--personal-primary)] px-1.5 text-[11px] leading-none font-semibold text-[var(--personal-primary-text)] tabular-nums"
      >
        {count > 99 ? "99+" : count}
      </span>
      <span className="sr-only">, {unreadChatsLabel(count)}</span>
    </span>
  );
}

/**
 * A single unread dot: one chat in a bot's chat list, or a pinned face. The
 * caller names it to assistive tech (the row or tile label already does).
 */
export function UnreadDot({ className }: { readonly className?: string | undefined }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="unread-dot"
      className={cn("size-2.5 shrink-0 rounded-full bg-[var(--personal-primary)]", className)}
    />
  );
}
