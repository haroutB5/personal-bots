import type { BrowserNavigationTarget } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

export type BrowserUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The shared browser only ever navigates to http(s). Schemeless hosts follow
 * the preview convention (loopback -> http, public -> https); javascript:,
 * file:, data:, chrome: and every other scheme are rejected.
 */
export function resolveBrowserUrl(raw: string): BrowserUrlResult {
  try {
    return { ok: true, url: normalizePreviewUrl(raw) };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : "Only http and https URLs can be opened.",
    };
  }
}

/**
 * Environment-port targets resolve against this machine: the server-owned
 * browser runs next to the dev servers, so loopback is the right host.
 */
export function resolveBrowserNavigationTarget(target: BrowserNavigationTarget): BrowserUrlResult {
  if (target.kind === "url") return resolveBrowserUrl(target.url);
  const path =
    target.path === undefined ? "" : target.path.startsWith("/") ? target.path : `/${target.path}`;
  return resolveBrowserUrl(`${target.protocol ?? "http"}://localhost:${target.port}${path}`);
}
