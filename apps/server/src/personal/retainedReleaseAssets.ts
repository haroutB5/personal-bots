/**
 * Build assets from the releases kept on disk next to the active one.
 *
 * The installed app can boot the previous release's client from the service
 * worker's cached shell right after a restart. That client still asks for its
 * own content-hashed chunks, which the new release does not have. Answering
 * those with the SPA's index.html makes every lazy import fail with a MIME
 * error until the page reloads, so /assets/* is served from the active release,
 * then from any retained release (scripts/personal/prune-releases.ps1 keeps the
 * newest few), and otherwise answered 404, never HTML.
 *
 * Release layout: <releases>/<sha>/dist/client is the static root.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** `assets/<file>` with a single, plain file name (already normalized, `/` separators). */
const BUILD_ASSET_PATH = /^assets\/[^/\\]+$/;

export function isBuildAssetPath(relativePath: string): boolean {
  return relativePath === "assets" || relativePath.startsWith("assets/");
}

/**
 * The folder holding every release when `staticRoot` sits in the release layout,
 * otherwise null (dev servers and the monorepo build have no siblings to search).
 */
export function releasesDirOf(staticRoot: string, path: Path.Path): string | null {
  const distDir = path.dirname(staticRoot);
  if (path.basename(staticRoot) !== "client" || path.basename(distDir) !== "dist") return null;
  return path.dirname(path.dirname(distDir));
}

/**
 * Absolute path of `relativePath` (`assets/<file>`) in another retained
 * release, or null. Never reads outside `<releases>/<name>/dist/client/assets`.
 */
export const findRetainedReleaseAsset = Effect.fn("findRetainedReleaseAsset")(function* (
  staticRoot: string,
  relativePath: string,
) {
  if (!BUILD_ASSET_PATH.test(relativePath)) return null;
  const fileName = relativePath.slice("assets/".length);
  if (fileName === "." || fileName === ".." || fileName.includes("\0")) return null;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const releasesDir = releasesDirOf(path.resolve(staticRoot), path);
  if (releasesDir === null) return null;
  const active = path.resolve(staticRoot);
  const releases = yield* fileSystem
    .readDirectory(releasesDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const release of releases) {
    const clientDir = path.join(releasesDir, release, "dist", "client");
    if (path.resolve(clientDir) === active) continue;
    const candidate = path.join(clientDir, "assets", fileName);
    const info = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => null));
    if (info?.type === "File") return candidate;
  }
  return null;
});
