/**
 * `GET /api/personal/android/apk/<version>`: the current APK, for the phone's
 * self-updater. Bearer only, because it runs outside a browser and must never
 * be reachable with a cookie.
 *
 * The version is the manifest's version, never a path the client composes:
 * it decodes as `HbotsVersion`, must equal the published release, and only
 * then becomes `hbots-<version>.apk` under the data root.
 */
import { AuthOrchestrationReadScope, HbotsVersion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import { authenticateBearerPersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import {
  ANDROID_APK_CONTENT_TYPE,
  ANDROID_UPDATES_DIR,
  readLatestAndroidRelease,
} from "./latestRelease.ts";

export const PERSONAL_ANDROID_APK_ROUTE_PREFIX = "/api/personal/android/apk";

const decodeVersion = Schema.decodeUnknownOption(HbotsVersion);

const badRequest = () => HttpServerResponse.text("Bad Request", { status: 400 });
const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

export const personalAndroidApkRouteLayer = HttpRouter.add(
  "GET",
  `${PERSONAL_ANDROID_APK_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* authenticateBearerPersonalRoute(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = (request.url ?? "").split("?", 1)[0] ?? "";
    if (!pathname.startsWith(`${PERSONAL_ANDROID_APK_ROUTE_PREFIX}/`)) return badRequest();
    const encodedVersion = pathname.slice(`${PERSONAL_ANDROID_APK_ROUTE_PREFIX}/`.length);
    const versionText = yield* Effect.try({
      try: () => decodeURIComponent(encodedVersion),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (versionText === null) return badRequest();
    const version = decodeVersion(versionText);
    if (Option.isNone(version)) return badRequest();

    const config = yield* ServerConfig.ServerConfig;
    const latest = yield* readLatestAndroidRelease(config.baseDir);
    if (latest === null || latest.version !== version.value) return notFound();

    const path = yield* Path.Path;
    const apkPath = path.join(config.baseDir, ANDROID_UPDATES_DIR, `hbots-${version.value}.apk`);
    return yield* HttpServerResponse.file(apkPath, {
      headers: {
        "Content-Type": ANDROID_APK_CONTENT_TYPE,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(Effect.orElseSucceed(notFound));
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);
