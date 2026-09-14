import type { JSX } from "react";

import { Outlet, useLocation } from "@tanstack/react-router";

import { useMediaQuery } from "~/hooks/useMediaQuery";

import { ChatsScreen } from "./ChatsScreen";
import { PersonalOfflineBanner } from "./PersonalOfflineBanner";
import { activeTabFor } from "./personalMode";
import { PersonalTabBar } from "./PersonalTabBar";
import { useHiddenRootAttribute } from "./useHiddenRootAttribute";

/**
 * Layout for /bots, /tasks, /computer and /files. One scroller per column
 * (the body never scrolls), `100dvh`, safe-area insets on every edge.
 *
 * Phone: the routed screen fills the column and the tab bar sits below it
 * (hidden on focused editors). md+: the bot list is a fixed left column with
 * the tab bar, and the routed screen fills the right side.
 */
export function PersonalShell(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const isWide = useMediaQuery("md");
  const activeTab = activeTabFor(pathname);
  useHiddenRootAttribute();

  if (!isWide) {
    return (
      <div className="personal-app flex h-dvh flex-col overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <div className="pt-[env(safe-area-inset-top)]">
          <PersonalOfflineBanner />
        </div>
        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          <Outlet />
        </main>
        {activeTab !== null ? <PersonalTabBar active={activeTab} /> : null}
      </div>
    );
  }

  const showsChats = activeTab === "chats" && pathname.replace(/\/$/, "") === "/bots";
  return (
    <div className="personal-app flex h-dvh overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <aside
        aria-label="Bots"
        className="flex w-[380px] shrink-0 flex-col border-r border-[var(--personal-border)]"
      >
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)]">
          <ChatsScreen />
        </div>
        <PersonalTabBar active={activeTab ?? "chats"} />
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-[env(safe-area-inset-top)]">
        <PersonalOfflineBanner />
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {showsChats ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-[15px] text-[var(--personal-text-secondary)]">
              Choose a bot on the left to open its latest chat.
            </div>
          ) : (
            <div className="mx-auto h-full max-w-[560px]">
              <Outlet />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
