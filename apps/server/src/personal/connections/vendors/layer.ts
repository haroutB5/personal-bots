import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ConnectionVendorAdapters, makeAdapters } from "../adapters.ts";
import { makeEmailAdapter } from "../email/adapter.ts";
import { makeGmailApi } from "../email/gmailApi.ts";
import { makeGraphMailApi } from "../email/graphMailApi.ts";
import { EmailOAuthClients } from "../email/oauthClients.ts";
import { EmailOAuthEndpoints } from "../email/oauthEndpoints.ts";
import { EmailOAuthHttp } from "../email/oauthHttp.ts";
import { EmailTokenBroker } from "../email/tokenBroker.ts";
import { makeWhatsAppAdapter } from "../whatsapp/adapter.ts";
import { WhatsAppSendLog } from "../whatsapp/sendLog.ts";
import { WhatsAppSession } from "../whatsapp/session.ts";
import { makeGithubAdapter } from "./github.ts";
import { makeNeonAdapter } from "./neon.ts";
import { makeUpstashAdapter } from "./upstash.ts";
import { makeFetchVendorHttp } from "./vendorHttp.ts";
import { makeVercelAdapter } from "./vercel.ts";

/**
 * The adapters that ship. A vendor absent from this list is refused by name at
 * the gateway rather than half-executed; so is an operation whose vendor is
 * here but which its adapter does not speak for, which is what
 * `neon.run_sql` and `upstash.redis_command` still are.
 *
 * This is a `Layer.effect` rather than a plain value because WhatsApp is not
 * an HTTP client: it drives the shared browser and keeps a persisted send
 * ledger, so its adapter is built from services rather than from a fetch.
 */
const http = makeFetchVendorHttp();

export const layer = Layer.effect(
  ConnectionVendorAdapters,
  Effect.gen(function* () {
    const session = yield* WhatsAppSession;
    const sendLog = yield* WhatsAppSendLog;
    const email = {
      vendorHttp: http,
      broker: yield* EmailTokenBroker,
      clients: yield* EmailOAuthClients,
      oauthHttp: yield* EmailOAuthHttp,
      endpoints: yield* EmailOAuthEndpoints,
    };
    return makeAdapters([
      makeGithubAdapter(http),
      makeVercelAdapter(http),
      makeNeonAdapter(http),
      makeUpstashAdapter(http),
      makeWhatsAppAdapter({ session, sendLog }),
      yield* makeEmailAdapter("gmail", makeGmailApi(http), email),
      yield* makeEmailAdapter("outlook", makeGraphMailApi(http), email),
    ]);
  }),
);
