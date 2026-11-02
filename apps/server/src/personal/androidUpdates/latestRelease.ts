/**
 * Reads the published Android release beside the data root:
 * `<baseDir>/android-updates/latest.json`. The publish script owns that file;
 * this server only reads it. A missing, oversized, unreadable or invalid file
 * is "no release", never an error on a request path.
 */
// @effect-diagnostics nodeBuiltinImport:off - FileSystem has no lstat, and a link must be refused before it is resolved.
import * as NodeFSP from "node:fs/promises";

import {
  PersonalAndroidRelease,
  type PersonalAndroidRelease as PersonalAndroidReleaseType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const ANDROID_UPDATES_DIR = "android-updates";
export const ANDROID_LATEST_MANIFEST = "latest.json";
export const ANDROID_APK_CONTENT_TYPE = "application/vnd.android.package-archive";

/** The manifest is a few hundred bytes; anything larger is not one. */
export const ANDROID_MANIFEST_MAX_BYTES = 64 * 1024;

const AndroidManifest = Schema.Struct({
  schema: Schema.Literal(1),
  ...PersonalAndroidRelease.fields,
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(AndroidManifest));

const toRelease = (manifest: typeof AndroidManifest.Type): PersonalAndroidReleaseType => ({
  version: manifest.version,
  sha256: manifest.sha256,
  size: manifest.size,
  notes: manifest.notes,
});

export const refuseAndroidUpdateFile = (fileName: string, reason: string) =>
  Effect.logWarning("android update file refused", { fileName, reason }).pipe(Effect.as(null));

export const resolveAndroidUpdateFile = (baseDir: string, fileName: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const requestedPath = path.join(baseDir, ANDROID_UPDATES_DIR, fileName);

    const entry = yield* Effect.tryPromise(() => NodeFSP.lstat(requestedPath)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (entry === null) return null;
    if (!entry.isFile()) return yield* refuseAndroidUpdateFile(fileName, "not a regular file");

    const canonicalBaseDir = yield* fileSystem
      .realPath(baseDir)
      .pipe(Effect.orElseSucceed(() => null));
    if (canonicalBaseDir === null) {
      return yield* refuseAndroidUpdateFile(fileName, "its base folder cannot be resolved");
    }
    const canonicalPath = yield* fileSystem
      .realPath(requestedPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (canonicalPath === null) {
      return yield* refuseAndroidUpdateFile(fileName, "its real path cannot be resolved");
    }
    if (canonicalPath !== path.join(canonicalBaseDir, ANDROID_UPDATES_DIR, fileName)) {
      return yield* refuseAndroidUpdateFile(
        fileName,
        "its real path is outside the updates folder",
      );
    }
    return canonicalPath;
  });

export const readLatestAndroidRelease = (baseDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const manifestPath = yield* resolveAndroidUpdateFile(baseDir, ANDROID_LATEST_MANIFEST);
    if (manifestPath === null) return null;
    const info = yield* fileSystem.stat(manifestPath);
    if (info.size > BigInt(ANDROID_MANIFEST_MAX_BYTES)) {
      return yield* refuseAndroidUpdateFile(
        ANDROID_LATEST_MANIFEST,
        "larger than the manifest cap",
      );
    }
    const text = yield* fileSystem.readFileString(manifestPath);
    const manifest = decodeManifest(text);
    return Option.isNone(manifest) ? null : toRelease(manifest.value);
  }).pipe(Effect.orElseSucceed(() => null));
