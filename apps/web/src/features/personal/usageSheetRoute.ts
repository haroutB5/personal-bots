import { useCallback } from "react";

import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";

const TEAM_PATH = "/bots/team";

/**
 * Set on the history entry that opened a bot's usage sheet from the Team
 * screen. It tells a later close that the entry directly behind is the Team
 * screen without the sheet, so closing can step back instead of stacking a
 * second Team entry. It lives in the browser's history state, so it survives a
 * reload; a deep link has no such mark and closes by replacing instead.
 */
export const USAGE_SHEET_STATE_KEY = "personalUsageSheet";

function isTeamPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === TEAM_PATH;
}

/** The bot a location's `?usage=` names, only on the Team screen. */
export function usageBotOfLocation(location: {
  readonly pathname: string;
  readonly search: unknown;
}): string | null {
  if (!isTeamPath(location.pathname)) return null;
  const usage = (location.search as Record<string, unknown> | undefined)?.usage;
  return typeof usage === "string" && usage !== "" ? usage : null;
}

/** Whether this history entry was pushed to open the sheet (see USAGE_SHEET_STATE_KEY). */
export function openedSheetHere(state: unknown): boolean {
  return (state as Record<string, unknown> | null | undefined)?.[USAGE_SHEET_STATE_KEY] === true;
}

/**
 * The bot usage sheet as a part of the URL: `/bots/team?usage=<botId>`.
 *
 * - Open pushes an entry, so Back, swipe-back and the browser's Back close the
 *   sheet and stay on the Team screen with its scroll.
 * - Close (the ×, the scrim, Esc, drag-down) steps back when this session
 *   pushed the entry, and replaces the entry otherwise (a deep link, a reload
 *   with the mark gone), so it never leaves Team and never stacks.
 * - Open chat closes first, then pushes the chat from the Team entry: the chat
 *   is then "opened from Team" and its Back returns to Team without the sheet.
 *
 * It subscribes to one string only, so opening and closing the sheet re-renders
 * the usage card and nothing else on the screen.
 */
export function useUsageSheetRoute(): {
  readonly openBotId: string | null;
  readonly open: (botId: string) => void;
  readonly close: () => void;
  readonly openChat: (botId: string) => void;
} {
  const router = useRouter();
  const navigate = useNavigate();
  const openBotId = useLocation({ select: usageBotOfLocation });

  const open = useCallback(
    (botId: string) => {
      void navigate({
        to: TEAM_PATH,
        search: { usage: botId },
        state: { [USAGE_SHEET_STATE_KEY]: true } as never,
      });
    },
    [navigate],
  );

  const close = useCallback(() => {
    if (openedSheetHere(router.history.location.state)) {
      router.history.back();
      return;
    }
    void navigate({ to: TEAM_PATH, search: {}, replace: true });
  }, [navigate, router]);

  const openChat = useCallback(
    (botId: string) => {
      const goToChat = () => void navigate({ to: "/bots/$botId", params: { botId } });
      if (openedSheetHere(router.history.location.state)) {
        // Land on the Team entry first; the chat is then pushed from it.
        const stop = router.history.subscribe(() => {
          stop();
          setTimeout(goToChat, 0);
        });
        router.history.back();
        return;
      }
      void navigate({ to: TEAM_PATH, search: {}, replace: true }).then(goToChat);
    },
    [navigate, router],
  );

  return { openBotId, open, close, openChat };
}
