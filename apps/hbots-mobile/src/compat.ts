import * as Schema from "effect/Schema";

import { requestJson } from "./http";

const decodeCompat = Schema.decodeUnknownSync(
  Schema.Struct({ serverVersion: Schema.NullOr(Schema.String) }),
);

/** The header shows this version. A server without the route, or a failed read, shows none. */
export async function fetchServerVersion(httpBaseUrl: string): Promise<string | null> {
  try {
    const body = await requestJson("compat", new URL("/api/personal/client-compat", httpBaseUrl));
    return decodeCompat(body).serverVersion;
  } catch {
    return null;
  }
}
