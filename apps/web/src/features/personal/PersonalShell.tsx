import type { CSSProperties, JSX } from "react";
import { useRef } from "react";

import { Outlet, useLocation, useParams } from "@tanstack/react-router";

import { useMediaQuery } from "~/hooks/useMediaQuery";

import { ChatsScreen } from "./ChatsScreen";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import {
  SIDEBAR_ID,
  SIDEBAR_WIDTH,
  sidebarMaxWidth,
  sidebarWidthCss,
  useChatSidePanel,
} from "./desktopColumns";
import { PersonalOfflineBanner } from "./PersonalOfflineBanner";
import {
  activeTabFor,
  type DesktopPaneLayout,
  desktopPaneLayout,
  sidebarSelectionKey,
} from "./personalMode";
import { setPersonalNumberPreference, usePersonalNumberPreference } from "./personalPreferences";
import { PersonalTabBar } from "./PersonalTabBar";
import { TeamScreen } from "./TeamScreen";
import { useHiddenRootAttribute } from "./useHiddenRootAttribute";

/**
 * Width of the routed screen inside the desktop pane. A chat takes the whole
 * pane and centres its own content (`.personal-column`); everything else sits
 * in a centred column. Never a max-width box on a chat: that is what left a
 * narrow chat floating mid-screen with empty gutters either side.
 */
const PANE_CONTENT_CLASS: Record<DesktopPaneLayout, string> = {
  conversation: "h-full",
  column: "mx-auto h-full w-full max-w-[var(--personal-reading-column)]",
  form: "mx-auto h-full w-full max-w-[var(--personal-form-column)]",
};

/**
 * Layout for /bots, /tasks, /computer and /files. One scroller per column
 * (the body never scrolls), `100dvh`, safe-area insets on every edge.
 *
 * Phone: the routed screen fills the column and the tab bar sits below it
 * (hidden on focused editors). md+: the bot list is a fixed left column with
 * the tab bar, and the routed screen fills the pane to its right. With no chat
 * open the pane shows the team rather than an empty page, and with one open
 * its row in the list is marked. The list's inner edge drags to resize it
 * (`desktopColumns` has the limits).
 */
export function PersonalShell(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const isWide = useMediaQuery("md");
  const activeTab = activeTabFor(pathname);
  useHiddenRootAttribute();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sidebarWidth = usePersonalNumberPreference("sidebarWidth");
  const sidePanel = useChatSidePanel();
  // The chat open in the pane, marked in the bot list beside it. Straight off
  // the route params, so it follows every navigation and holds no state.
  const selectedChat = useParams({ strict: false, select: sidebarSelectionKey });

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

  const showsHome = activeTab === "chats" && pathname.replace(/\/$/, "") === "/bots";
  const layout = desktopPaneLayout(pathname);
  // A bot chat (not a group) is where the side panel opens; the list leaves
  // room for it there.
  const sidePanelOpen =
    sidePanel.open && layout === "conversation" && !pathname.startsWith("/bots/groups/");
  return (
    <div
      ref={rootRef}
      className="personal-app flex h-dvh overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
      style={
        {
          "--personal-sidebar-width": `${sidebarWidth}px`,
          "--personal-sidebar-effective": sidebarWidthCss(sidePanelOpen),
        } as CSSProperties
      }
    >
      <aside
        id={SIDEBAR_ID}
        aria-label="Bots"
        className="relative flex shrink-0 flex-col border-r border-[var(--personal-border)]"
        style={{ width: "var(--personal-sidebar-effective)" }}
      >
        <div className="personal-scroll-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)]">
          <ChatsScreen selectedChat={selectedChat} />
        </div>
        <PersonalTabBar active={activeTab ?? "chats"} />
        <ColumnResizeHandle
          label="Resize bot list"
          edge="right"
          controls={SIDEBAR_ID}
          value={sidebarWidth}
          min={SIDEBAR_WIDTH.min}
          maxWidth={() => sidebarMaxWidth(window.innerWidth, sidePanelOpen)}
          defaultWidth={SIDEBAR_WIDTH.default}
          cssVar="--personal-sidebar-width"
          target={() => rootRef.current}
          measure={() => document.getElementById(SIDEBAR_ID)?.getBoundingClientRect().width ?? null}
          onCommit={(next) => setPersonalNumberPreference("sidebarWidth", next)}
        />
      </aside>
      <main className="personal-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-[env(safe-area-inset-top)]">
        <PersonalOfflineBanner />
        <div className="personal-scroll-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {showsHome ? (
            <div className={PANE_CONTENT_CLASS.column}>
              <TeamScreen showBack={false} />
            </div>
          ) : (
            <div className={PANE_CONTENT_CLASS[layout]}>
              <Outlet />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
