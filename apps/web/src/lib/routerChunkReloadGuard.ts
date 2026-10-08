/**
 * TanStack Router reloads the page by itself when a route's code cannot be
 * fetched: `lazyRouteComponent` asks `sessionStorage` whether it already
 * reloaded for this error message and, if not, calls `window.location.reload()`.
 * With no network that reload boots the saved shell straight into the root
 * "Laptop offline" screen. While the server looks unreachable the answer is
 * "already reloaded", so the router throws the error instead (the route's error
 * screen, `RouteLoadError`, says the screen is not on the phone yet and opens
 * it once the connection is back). With the server reachable nothing changes.
 */
const ROUTER_RELOAD_KEY_PREFIX = "tanstack_router_reload:";

export function installRouterChunkReloadGuard(isAway: () => boolean): void {
  if (typeof Storage === "undefined") return;
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = function getItem(this: Storage, key: string): string | null {
    if (key.startsWith(ROUTER_RELOAD_KEY_PREFIX) && isAway()) return "1";
    return original.call(this, key);
  };
}
