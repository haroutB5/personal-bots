// @effect-diagnostics preferSchemaOverJson:off - a provider token reply is arbitrary JSON; each caller narrows what it reads.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { vendorFailure } from "../vendors/vendorHttp.ts";
import type { ConnectionVendorError } from "../adapters.ts";

/**
 * The form post a token endpoint takes. A secret travels as `Redacted` until
 * the body is built, so a request object printed by accident shows nothing.
 */
export interface OAuthFormRequest {
  readonly operationId: string;
  readonly url: string;
  readonly form: Readonly<Record<string, string | Redacted.Redacted<string>>>;
}

export interface OAuthFormResponse {
  readonly status: number;
  readonly body: unknown;
}

export type OAuthFormPost = (
  request: OAuthFormRequest,
) => Effect.Effect<OAuthFormResponse, ConnectionVendorError>;

export class EmailOAuthHttp extends Context.Service<
  EmailOAuthHttp,
  { readonly post: OAuthFormPost }
>()("t3/personal/connections/email/oauthHttp/EmailOAuthHttp") {}

const encodeForm = (form: OAuthFormRequest["form"]) =>
  new URLSearchParams(
    Object.entries(form).map(([name, value]): [string, string] => [
      name,
      typeof value === "string" ? value : Redacted.value(value),
    ]),
  ).toString();

export const makeFetchOAuthPost =
  (fetchImpl: typeof globalThis.fetch = globalThis.fetch): OAuthFormPost =>
  (request) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(request.url, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: encodeForm(request.form),
          }),
        catch: () =>
          vendorFailure(request.operationId, "Could not reach the provider's sign-in service."),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () =>
          vendorFailure(request.operationId, "Could not read the provider's sign-in reply."),
      });
      const body = ((): unknown => {
        if (text.length === 0) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })();
      return { status: response.status, body };
    });

export const layerFetch = Layer.succeed(EmailOAuthHttp, { post: makeFetchOAuthPost() });
export const layerOf = (post: OAuthFormPost) => Layer.succeed(EmailOAuthHttp, { post });
