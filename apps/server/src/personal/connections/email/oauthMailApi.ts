import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import type { ConnectionVendorError } from "../adapters.ts";
import type { MailApi, MailDraft } from "./mailApi.ts";

export interface OAuthMailCall {
  readonly operationId: string;
  readonly token: Redacted.Redacted<string>;
}

export interface OAuthMailApi extends MailApi<OAuthMailCall> {
  readonly send: (
    call: OAuthMailCall,
    draft: MailDraft,
  ) => Effect.Effect<void, ConnectionVendorError>;
}
