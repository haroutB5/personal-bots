import { useLocation } from "@tanstack/react-router";

import { backTargetOfState } from "./botsBackStack";

export interface PersonalBackTarget {
  readonly to: "/bots" | "/bots/team";
  readonly label: "Back to Bots" | "Back to Team";
}

/**
 * Where a page's Back arrow goes. A page opened from the Team screen (a bot's
 * page, its edit form, a chat, a task) goes back to the Team screen; anything
 * else keeps going to the Bots list. The arrow is a plain link: when its
 * target is right behind, botsBackStack.ts turns it into a history step back.
 */
export function usePersonalBackTarget(): PersonalBackTarget {
  const state = useLocation({ select: (location) => location.state });
  const to = backTargetOfState(state);
  return { to, label: to === "/bots/team" ? "Back to Team" : "Back to Bots" };
}
