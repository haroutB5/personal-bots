/**
 * Whether this browser session asks the server for the composer's provider
 * workspace data -- `workspaceSnapshots`, `slashCommands` and `skills`.
 *
 * Measured on the live install: those three fields are 119,412 B of a
 * 145,187 B boot snapshot, and the whole provider catalog is rebroadcast to
 * every connected client every ~40 s, because a health poll moves three
 * `checkedAt` timestamps. The personal shell reads none of the three (its
 * usage strip renders `usageLimits.checkedAt`, which is why the catalog is
 * published at all), so a phone left open pulls ~111 KB per poll for nothing.
 *
 * The subscription payload is fixed when the connection layer is built, so
 * the decision is made once, at boot, from the URL the app launched on. That
 * makes leaving the personal shell mid-session the one hazard: the upstream
 * composer would come up with no slash commands and no skills. It is handled
 * by reloading on the way out (`shouldReloadForProviderWorkspaceData`), which
 * rebuilds the connection with the full catalog. There are only two ways out
 * -- "Developer view" in personal settings and "Answer in Developer view" on
 * an unanswered question -- and both are deliberate one-way moves into a
 * different shell. The upstream first-run wizard never redirects off a
 * personal route (see FirstRunGate), so nothing takes this path implicitly.
 */
import { isElectron } from "~/env";

import { isPersonalPath } from "./personalMode";

export function shouldOmitProviderWorkspaceData(input: {
  readonly pathname: string;
  /** Desktop is the full IDE and keeps the upstream behaviour unchanged. */
  readonly electron: boolean;
}): boolean {
  return !input.electron && isPersonalPath(input.pathname);
}

/**
 * Routes the app shows before it is authenticated -- the same set `__root`
 * renders without any app shell. An unauthenticated personal launch is sent
 * to `/pair` by the `_personal` route, so these have to be exempt or the
 * pairing flow would reload under a user who is already mid-recovery. They
 * cannot render a composer: there is no environment to read a catalog from.
 */
function isPreAuthPath(pathname: string): boolean {
  return pathname === "/pair" || pathname === "/connect" || pathname.startsWith("/connect/");
}

/**
 * Reload rather than navigate when a session that opted out leaves the
 * personal shell for a route that may render the composer. Terminating by
 * construction: after the reload the boot decision above reads a non-personal
 * pathname, so `omitted` is false and the condition cannot hold again.
 */
export function shouldReloadForProviderWorkspaceData(input: {
  readonly omitted: boolean;
  readonly pathname: string;
}): boolean {
  if (!input.omitted) return false;
  return !isPersonalPath(input.pathname) && !isPreAuthPath(input.pathname);
}

/** Frozen at boot; read by the connection layer and the escalation guard. */
export const PROVIDER_WORKSPACE_DATA_OMITTED: boolean = shouldOmitProviderWorkspaceData({
  pathname: typeof window === "undefined" ? "/" : window.location.pathname,
  electron: isElectron,
});
