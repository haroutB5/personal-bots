/**
 * `GET /api/personal/client-compat`: the version handshake an Android client
 * reads before it talks to this server. It says which hbots release the
 * server runs and the oldest APK that may connect.
 *
 * Open to anonymous callers on purpose. It exposes only the served
 * `version.txt` stamp and one constant, both already public, and the phone
 * must learn that it is too old before it holds any session credential.
 */
import {
  HbotsVersion,
  PERSONAL_ANDROID_MINIMUM_NATIVE_VERSION,
  type PersonalClientCompat,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { readLatestAndroidRelease } from "../androidUpdates/latestRelease.ts";
import { readLiveHbotsVersion } from "../releaseVersion.ts";

export const PERSONAL_CLIENT_COMPAT_PATH = "/api/personal/client-compat";

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const decodeVersion = Schema.decodeUnknownOption(HbotsVersion);

export const personalClientCompatRouteLayer = HttpRouter.add(
  "GET",
  PERSONAL_CLIENT_COMPAT_PATH,
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ServerConfig);
    const staticDir = config._tag === "Some" ? config.value.staticDir : undefined;
    const baseDir = config._tag === "Some" ? config.value.baseDir : undefined;
    const live = yield* readLiveHbotsVersion(staticDir);
    // A stamp the schema refuses is "unknown", not a reason to fail: an old
    // or hand-edited version.txt must never take the handshake down.
    const latest = baseDir === undefined ? null : yield* readLatestAndroidRelease(baseDir);
    const compat: PersonalClientCompat = {
      serverVersion: live === null ? null : Option.getOrNull(decodeVersion(live)),
      android: {
        minimumNativeVersion: PERSONAL_ANDROID_MINIMUM_NATIVE_VERSION,
        latest,
      },
    };
    return yield* HttpServerResponse.json(compat, { headers: HEADERS });
  }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("Internal Server Error", { status: 500, headers: HEADERS }),
    ),
  ),
);
