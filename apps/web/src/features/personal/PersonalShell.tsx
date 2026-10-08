import type { CSSProperties, JSX } from "react";
import { Activity, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { Outlet, useLocation, useParams, useRouter, useRouterState } from "@tanstack/react-router";

import { ChunkLoadBoundary } from "~/lib/ChunkLoadBoundary";
import { useMediaQuery } from "~/hooks/useMediaQuery";

import { ChatsScreen } from "./ChatsScreen";
import { useChatSwipeBack } from "./useChatSwipeBack";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import {
  SIDEBAR_ID,
  SIDEBAR_WIDTH,
  sidebarMaxWidth,
  sidebarWidthCss,
  useChatSidePanel,
} from "./desktopColumns";
import { InAppNotifications } from "./InAppNotifications";
import { OutboxFlusher } from "./OutboxFlusher";
import { useKeptBotsList, useKeptBotsListScroll } from "./keptBotsList";
import { whenIdle } from "./perfFlags";
import { installPerfRum } from "./perfRum";
import { PersonalOfflineBanner } from "./PersonalOfflineBanner";
import {
  activeTabFor,
  type DesktopPaneLayout,
  desktopPaneLayout,
  sidebarSelectionKey,
} from "./personalMode";
import { setPersonalNumberPreference, usePersonalNumberPreference } from "./personalPreferences";
import { PersonalTabBar } from "./PersonalTabBar";
import { useHiddenRootAttribute } from "./useHiddenRootAttribute";
import { warmPersonalRoutes } from "./warmRoutes";

// Desktop home pane only: the phone never shows it, so it stays off the
// chats list's startup path.
const TeamScreen = lazy(() =>
  import("./TeamScreen").then((module) => ({ default: module.TeamScreen })),
);

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
// Watches visibility and chat-row taps for the real-user timings (perfRum.ts).
installPerfRum();

export function PersonalShell(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const isWide = useMediaQuery("md");
  const activeTab = activeTabFor(pathname);
  useHiddenRootAttribute();
  const router = useRouter();
  useEffect(() => warmPersonalRoutes(router), [router]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sidebarWidth = usePersonalNumberPreference("sidebarWidth");
  const sidePanel = useChatSidePanel();
  // The chat open in the pane, marked in the bot list beside it. Straight off
  // the route params, so it follows every navigation and holds no state.
  const selectedChat = useParams({ strict: false, select: sidebarSelectionKey });
  const swipeBack = useChatSwipeBack({ wide: isWide });
  // Phone: the Bots list stays mounted under the pages opened from it
  // (keptBotsList.ts). One element for the life of the shell, so the shell's
  // own re-renders (every navigation) never re-render the hidden list.
  // Keyed off the page the router has rendered, not the address: while a tap's
  // navigation is pending the Outlet still renders the /bots match, and
  // switching to it then mounted a second, visible Bots list for a moment.
  const renderedPath = useRouterState({
    select: (state) => state.matches.at(-1)?.pathname ?? state.location.pathname,
  });
  const mainRef = useRef<HTMLElement | null>(null);
  const keptList = useKeptBotsList(renderedPath, isWide);
  useKeptBotsListScroll(mainRef, keptList);
  const keptListElement = useMemo(() => <ChatsScreen />, []);
  // Hiding the list in Activity disconnects every row's effects, which cost
  // the opening tap as much as the unmount it replaces. The tap only takes it
  // out of the page (display: none on a display: contents wrapper, so layout
  // is unchanged); Activity puts it to sleep once the main thread is idle,
  // after the chat has painted and mounted. Showing it again is immediate.
  const [keptListAsleep, setKeptListAsleep] = useState(false);
  if (keptList.shown && keptListAsleep) setKeptListAsleep(false);
  useEffect(() => {
    if (!keptList.kept || keptList.shown) return;
    return whenIdle(() => setKeptListAsleep(true), 1_000);
  }, [keptList.kept, keptList.shown]);
  const keptListMode = keptList.shown || !keptListAsleep ? "visible" : "hidden";

  if (!isWide) {
    return (
      <>
        <div
          className="personal-app flex h-dvh flex-col overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
          style={swipeBack.style}
        >
          <div className="pt-[env(safe-area-inset-top)]">
            <PersonalOfflineBanner />
          </div>
          <main
            ref={mainRef}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            {keptList.kept ? (
              <div style={{ display: keptList.shown ? "contents" : "none" }}>
                <Activity mode={keptListMode}>{keptListElement}</Activity>
              </div>
            ) : null}
            {keptList.shown ? null : <Outlet />}
          </main>
          {activeTab !== null ? <PersonalTabBar active={activeTab} /> : null}
          <InAppNotifications />
          <OutboxFlusher />
        </div>
        {swipeBack.layers}
      </>
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
              <ChunkLoadBoundary>
                <Suspense fallback={null}>
                  <TeamScreen showBack={false} />
                </Suspense>
              </ChunkLoadBoundary>
            </div>
          ) : (
            <div className={PANE_CONTENT_CLASS[layout]}>
              <Outlet />
            </div>
          )}
        </div>
      </main>
      <InAppNotifications />
      <OutboxFlusher />
    </div>
  );
}
