import { createDpopProof } from "./dpop";
import type { StoredSession } from "./session";
import { authMethodOf } from "./sessionAuth";

export async function authorizationHeaders(
  session: StoredSession,
  method: string,
  url: string,
): Promise<Record<string, string>> {
  if (authMethodOf(session) === "bearer") {
    return { authorization: `Bearer ${session.accessToken}` };
  }
  const proof = await createDpopProof({ method, url, accessToken: session.accessToken });
  return { authorization: `DPoP ${session.accessToken}`, dpop: proof.proof };
}

export async function authorizedFetch(
  session: StoredSession,
  url: URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(
    await authorizationHeaders(session, init.method ?? "GET", url.toString()),
  )) {
    headers.set(name, value);
  }
  return fetch(url, { ...init, headers });
}

/** Sends a request with a standalone bearer token (e.g. the out-of-band rescue reboot endpoint). */
export async function bearerTokenFetch(
  url: string | URL,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}
