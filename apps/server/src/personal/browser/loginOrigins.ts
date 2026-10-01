/**
 * Where page scripts stay disabled after a saved login.
 *
 * The persistent profile keeps the session a saved login created, so a
 * model-provided script must never run where it could read that session.
 * A cookie is visible to every port and scheme of its host, and to the whole
 * site when it is set with a Domain attribute, so the unit is not the origin
 * but the registrable domain (eTLD+1) under the Public Suffix List, the same
 * list Chrome uses to decide how wide a cookie may be scoped. IP addresses and
 * hosts that are themselves a public suffix (localhost) only ever hold
 * host-only cookies, so they are blocked by exact host, on every port.
 */
import { getDomain } from "tldts";

/** Thrown inside the page when the guard refuses; never a user-visible string. */
export const LOGIN_SCRIPT_REFUSED = "__hbots_login_site_script_refused__";

const httpHost = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return host === "" ? null : host;
};

/**
 * The host suffix whose pages can see the cookies a login on `origin` set, or
 * null when that cannot be worked out (the caller then blocks everywhere).
 */
export function loginCookieScope(origin: string): string | null {
  const host = httpHost(origin);
  if (host === null) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

const hostInScope = (host: string, scope: string) => host === scope || host.endsWith(`.${scope}`);

/**
 * The login origin whose cookies `pageUrl` can see, if any. A page that is not
 * http(s) has no host to compare, so it counts as blocked while any login
 * exists: about:blank and blob: documents can inherit a signed-in origin.
 */
export function loginOriginCovering(
  pageUrl: string,
  loginOrigins: Iterable<string>,
): { readonly origin: string } | "unknown" | null {
  const origins = [...loginOrigins];
  if (origins.length === 0) return null;
  const host = httpHost(pageUrl);
  if (host === null) return "unknown";
  for (const origin of origins) {
    const scope = loginCookieScope(origin);
    if (scope === null) return "unknown";
    if (hostInScope(host, scope)) return { origin };
  }
  return null;
}

/** Every scope, or null when one of them cannot be worked out. */
export function loginCookieScopes(loginOrigins: Iterable<string>): ReadonlyArray<string> | null {
  const scopes = new Set<string>();
  for (const origin of loginOrigins) {
    const scope = loginCookieScope(origin);
    if (scope === null) return null;
    scopes.add(scope);
  }
  return [...scopes];
}

/**
 * Wraps a model-provided expression so the page refuses it itself when the
 * document it lands in is on a login's site. The server checks the tab's URL
 * first, but the page can navigate between that check and the evaluation;
 * this check and the script run in the same synchronous turn of the same
 * document, so nothing can move in between. It reads only `location`, whose
 * properties a page cannot redefine (Chrome reports its hostname lowercased),
 * and compares by index, never through prototype methods a page can replace. `(0, eval)` runs the expression in global scope, exactly as
 * Playwright evaluates a string.
 */
export function guardedExpression(expression: string, scopes: ReadonlyArray<string>): string {
  return `(() => {
  const scopes = ${JSON.stringify(scopes)};
  const protocol = location.protocol;
  const host = location.hostname;
  let size = host.length;
  if (size > 0 && host[size - 1] === ".") size -= 1;
  let refused = size === 0 || (protocol !== "http:" && protocol !== "https:");
  for (let i = 0; !refused && i < scopes.length; i++) {
    const scope = scopes[i];
    const offset = size - scope.length;
    if (offset < 0 || (offset > 0 && host[offset - 1] !== ".")) continue;
    let same = true;
    for (let j = 0; j < scope.length; j++) {
      if (host[offset + j] !== scope[j]) { same = false; break; }
    }
    refused = same;
  }
  if (refused) throw ${JSON.stringify(LOGIN_SCRIPT_REFUSED)};
  return (0, eval)(${JSON.stringify(expression)});
})()`;
}
