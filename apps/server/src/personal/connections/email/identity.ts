import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import { ConnectionVendorError } from "../adapters.ts";
import type { VendorHttp } from "../vendors/vendorHttp.ts";
import type { EmailOAuthEndpointSet } from "./oauthEndpoints.ts";

/** Whose mailbox an access token opens. Safe to show the owner and to key a row on. */
export interface MailboxIdentity {
  readonly address: string;
  readonly displayName: string;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const unreadable = (operationId: string, status: number) =>
  new ConnectionVendorError({
    operationId,
    detail:
      status === 401 || status === 403
        ? "The provider did not accept the new sign-in."
        : "The provider did not say whose mailbox this is.",
    ...(status === 401 || status === 403 ? { unauthorized: true } : {}),
    status,
  });

export const gmailIdentity = Effect.fn("email.identity.gmail")(function* (
  http: VendorHttp,
  endpoints: EmailOAuthEndpointSet,
  accessToken: Redacted.Redacted<string>,
) {
  const operationId = "gmail.identity";
  const response = yield* http({
    operationId,
    method: "GET",
    url: endpoints.google.profileUrl,
    bearer: accessToken,
  });
  const address = text(record(response.body)["emailAddress"]);
  if (response.status < 200 || response.status >= 300 || address === null) {
    return yield* unreadable(operationId, response.status);
  }
  const lower = address.toLowerCase();
  return { address: lower, displayName: lower } satisfies MailboxIdentity;
});

export const outlookIdentity = Effect.fn("email.identity.outlook")(function* (
  http: VendorHttp,
  endpoints: EmailOAuthEndpointSet,
  accessToken: Redacted.Redacted<string>,
) {
  const operationId = "outlook.identity";
  const response = yield* http({
    operationId,
    method: "GET",
    url: endpoints.microsoft.profileUrl,
    bearer: accessToken,
  });
  const body = record(response.body);
  const address = text(body["mail"]) ?? text(body["userPrincipalName"]);
  if (response.status < 200 || response.status >= 300 || address === null) {
    return yield* unreadable(operationId, response.status);
  }
  return {
    address: address.toLowerCase(),
    displayName: text(body["displayName"]) ?? address,
  } satisfies MailboxIdentity;
});
