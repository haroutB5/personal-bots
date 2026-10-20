/** Checks for the "paste the address" sign-in step (provider-setup SPEC sections 6 and 7). */

export type PastedAddressCheck =
  | { readonly ok: true; readonly address: string }
  | {
      readonly ok: false;
      /** `denied`: Google says no, only Start again helps. Otherwise the field stays and explains. */
      readonly kind: "denied" | "signInPage" | "notAnAddress";
      readonly message: string;
    };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The loopback port the flow's redirect listens on, read from the sign-in link's `redirect_uri`. */
export function redirectPortOf(authorizationUrl: string | null): string | null {
  if (authorizationUrl === null) return null;
  try {
    const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");
    if (redirect === null) return null;
    const port = new URL(redirect).port;
    return port.length > 0 ? port : null;
  } catch {
    return null;
  }
}

const SIGN_IN_PAGE_MESSAGE =
  "That's the sign-in page, not the address Safari shows after it. That one starts with http://127.0.0.1";

/**
 * Before anything is sent: it must parse as a URL, point at this laptop's
 * loopback on the port of this flow, and carry a `code` or an `error`. The
 * value is never logged or echoed anywhere but the field it was pasted into.
 */
export function checkPastedAddress(
  pasted: string,
  authorizationUrl: string | null,
): PastedAddressCheck {
  const text = pasted.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      kind: "notAnAddress",
      message:
        "That doesn't look like an address. Copy the whole address from Safari's address bar.",
    };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, kind: "signInPage", message: SIGN_IN_PAGE_MESSAGE };
  }
  const port = redirectPortOf(authorizationUrl);
  if (port !== null && url.port !== port) {
    return { ok: false, kind: "signInPage", message: SIGN_IN_PAGE_MESSAGE };
  }
  const error = url.searchParams.get("error");
  if (error === "access_denied") {
    return {
      ok: false,
      kind: "denied",
      message: "Google says you said no. Start again to try once more.",
    };
  }
  if (!url.searchParams.has("code") && error === null) {
    return {
      ok: false,
      kind: "notAnAddress",
      message: "That address has no code in it. Copy the whole address Safari shows after Google.",
    };
  }
  return { ok: true, address: text };
}

/** Whole minutes left on a link, or null while it still has 10 or more (nothing to say yet). */
export function minutesLeft(expiresAt: string | null, nowMs: number): number | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.ceil((at - nowMs) / 60_000);
  return minutes < 10 ? Math.max(0, minutes) : null;
}
