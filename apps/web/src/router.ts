import { createRouter, RouterHistory } from "@tanstack/react-router";

import { RouteLoadError } from "./components/RouteLoadError";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
    // Route components are split chunks (autoCodeSplitting in vite.config);
    // fetching them on hover/focus intent hides the load from the first
    // settings or pull-request navigation.
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
