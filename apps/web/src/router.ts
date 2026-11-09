import { createRouter, RouterHistory } from "@tanstack/react-router";

import { RouteLoadError } from "./features/personal/RouteLoadError";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
    defaultPreload: "intent",
    // A page whose code cannot be fetched (no network, never opened before) says so
    // in place instead of showing a crash report; other errors keep the default screen.
    defaultErrorComponent: RouteLoadError,
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
