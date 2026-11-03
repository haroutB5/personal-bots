export interface PairingTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly credential: string;
}

export type PairingLinkError = "empty" | "not-a-url" | "not-https" | "no-token";

export type PairingLinkResult =
  | { readonly ok: true; readonly target: PairingTarget }
  | { readonly ok: false; readonly error: PairingLinkError };

export function describePairingLinkError(error: PairingLinkError): string {
  switch (error) {
    case "empty":
      return "Paste the pairing link first.";
    case "not-a-url":
      return "That is not a URL. Paste the full pairing link.";
    case "not-https":
      return "hbots only connects over https. Use the https address of your server.";
    case "no-token":
      return "The link has no token.";
    default:
      return error satisfies never;
  }
}

export function parsePairingLink(raw: string): PairingLinkResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "empty" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "not-a-url" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "not-https" };
  }
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const credential = (hash.get("token") ?? url.searchParams.get("token") ?? "").trim();
  if (credential.length === 0) {
    return { ok: false, error: "no-token" };
  }
  const httpBase = new URL(url.toString());
  httpBase.pathname = "/";
  httpBase.search = "";
  httpBase.hash = "";
  const wsBase = new URL(httpBase.toString());
  wsBase.protocol = "wss:";
  return {
    ok: true,
    target: { httpBaseUrl: httpBase.toString(), wsBaseUrl: wsBase.toString(), credential },
  };
}
