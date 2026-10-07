import { perfOptimizationOn } from "../features/personal/perfFlags";
import { PROVIDER_WORKSPACE_DATA_OMITTED } from "../features/personal/providerCatalogScope";

/**
 * Whether this document boots without the managed-auth (Clerk) shell.
 *
 * The Bots shell never signs in to T3 Connect: the phone pairs with a link and
 * keeps a session cookie, and nothing under `/bots`, `/tasks`, `/computer` or
 * `/files` reads Clerk. The shell used to load and mount anyway, which put its
 * chunk, two cross-origin scripts and two calls to the Clerk frontend API in
 * front of every launch (1.67.0).
 *
 * The decision is made once, at boot, from the launch URL, and it rides on the
 * same fact as the provider workspace data: `PROVIDER_WORKSPACE_DATA_OMITTED` is
 * true for exactly a non-Electron document that launched on a personal path, and
 * the only ways out of the personal shell reload the document (see
 * `shouldReloadForProviderWorkspaceData`), so the next document decides again
 * and loads Clerk for settings, the welcome wizard and the T3 Connect screens.
 *
 * Kill switch: bots:perf-off = "skip-clerk" (Clerk loads on every route again).
 */
export function shouldSkipManagedAuth(input: {
  readonly personalLaunch: boolean;
  readonly optimizationOn: boolean;
}): boolean {
  return input.personalLaunch && input.optimizationOn;
}

export const MANAGED_AUTH_SKIPPED: boolean = shouldSkipManagedAuth({
  personalLaunch: PROVIDER_WORKSPACE_DATA_OMITTED,
  optimizationOn: perfOptimizationOn("skip-clerk"),
});
