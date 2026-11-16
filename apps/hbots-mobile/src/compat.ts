import * as Schema from "effect/Schema";

import { requestJson } from "./http";
import { setPerfOff } from "./perfFlags";

export interface AndroidRelease {
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
  readonly notes: string;
}

export interface ClientCompat {
  readonly serverVersion: string | null;
  readonly minimumNativeVersion: string | null;
  readonly latest: AndroidRelease | null;
  /** Android switches the server turned off; empty from a server that does not send it. */
  readonly perfOff: ReadonlyArray<string>;
}

const decodeCompat = Schema.decodeUnknownSync(
  Schema.Struct({
    serverVersion: Schema.NullOr(Schema.String),
    android: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          minimumNativeVersion: Schema.String,
          latest: Schema.NullOr(
            Schema.Struct({
              version: Schema.String,
              sha256: Schema.String,
              size: Schema.Number,
              notes: Schema.String,
            }),
          ),
        }),
      ),
    ),
    perfOff: Schema.optional(Schema.Array(Schema.String)),
  }),
);

/** A server without the route, an old server, or a failed read shows no update. */
export async function fetchCompat(httpBaseUrl: string): Promise<ClientCompat | null> {
  try {
    const body = await requestJson("compat", new URL("/api/personal/client-compat", httpBaseUrl));
    const decoded = decodeCompat(body);
    const android = decoded.android ?? null;
    const perfOff = decoded.perfOff ?? [];
    setPerfOff(perfOff);
    return {
      serverVersion: decoded.serverVersion,
      minimumNativeVersion: android?.minimumNativeVersion ?? null,
      latest: android?.latest ?? null,
      perfOff,
    };
  } catch {
    return null;
  }
}

export function apkUrlFor(httpBaseUrl: string, release: AndroidRelease): string {
  return new URL(`/api/personal/android/apk/${encodeURIComponent(release.version)}`, httpBaseUrl)
    .href;
}
