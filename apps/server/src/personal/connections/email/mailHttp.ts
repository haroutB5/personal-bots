import * as Effect from "effect/Effect";

import { ConnectionVendorError } from "../adapters.ts";
import { describeFailure, type VendorHttp, type VendorHttpRequest } from "../vendors/vendorHttp.ts";
import type { OAuthMailCall } from "./oauthMailApi.ts";

/**
 * A 401 is a token the provider refused. A 403 counts only when it says the
 * permission itself is missing, because a 403 also answers a rate limit and a
 * folder the account cannot see, and neither means "sign in again".
 */
const refusesCredential = (status: number, text: string) =>
  status === 401 ||
  (status === 403 &&
    /insufficient|scope|access[ _-]?denied|AuthenticationFailed|invalid[ _-]?token/i.test(text));

export type MailRequest = Omit<VendorHttpRequest, "operationId" | "bearer">;

/** One authenticated call. A body that is not a success becomes a typed failure carrying the status. */
export const mailRequest = (http: VendorHttp, call: OAuthMailCall, request: MailRequest) =>
  http({ ...request, operationId: call.operationId, bearer: call.token }).pipe(
    Effect.flatMap((response) => {
      if (response.status >= 200 && response.status < 300) return Effect.succeed(response.body);
      const detail = describeFailure(response);
      return Effect.fail(
        new ConnectionVendorError({
          operationId: call.operationId,
          detail,
          status: response.status,
          ...(refusesCredential(response.status, detail) ? { unauthorized: true } : {}),
        }),
      );
    }),
  );

export const mailFailure = (call: OAuthMailCall, detail: string) =>
  new ConnectionVendorError({ operationId: call.operationId, detail });

/** Unix seconds for a date or date-time the bot typed, or null when it is not one. */
export const toEpochSeconds = (iso: string): number | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1_000);
};
