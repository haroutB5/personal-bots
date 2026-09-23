import { useEffect } from "react";

import { useRouter } from "@tanstack/react-router";

import { perfOptimizationOn, whenIdle } from "./perfFlags";

/** The route a chat row opens; its split chunks carry the transcript and composer. */
export const CHAT_ROUTE_ID = "/_personal/bots_/$botId/$threadId" as const;

/**
 * Loads the chat screen's code while the list sits idle, so tapping a chat
 * waits for the chat's data only, not for ~45 split chunks (~660 KB of JS,
 * the markdown renderer included) to download and evaluate. Hover/touch
 * intent preloading alone starts barely a hundred milliseconds before the
 * tap lands on a phone. Kill switch: "preload-chat" (perfFlags.ts).
 */
export function usePreloadChatRoute(ready: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!ready || !perfOptimizationOn("preload-chat")) return;
    return whenIdle(() => {
      const route = router.routesById[CHAT_ROUTE_ID] as
        | (typeof router.routesById)[typeof CHAT_ROUTE_ID]
        | undefined;
      if (route === undefined) return;
      // Undefined when the chunk is already loaded.
      void router.loadRouteChunk(route)?.catch(() => undefined);
    });
  }, [ready, router]);
}
