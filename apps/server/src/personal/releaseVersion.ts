/**
 * One reader for the hbots release version: the `version=` line in the served
 * client's `version.txt`, the stamp the build stamps into `staticDir`.
 *
 * The Performance tab, the update status line and the memory tidy-up all show
 * this number, so they must agree on what it is and on what a missing file
 * means. The value is a release version ("1.66.110"), not the upstream package
 * version ("0.0.42").
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The version this server runs, or null when there is no static dir (tests)
 * or no readable stamp. A missing or unreadable file is "unknown", never an
 * error on a request path.
 */
export const readLiveHbotsVersion = (staticDir: string | undefined) =>
  Effect.gen(function* () {
    if (staticDir === undefined) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem.readFileString(path.join(staticDir, "version.txt"));
    return /^version=(.+)$/m.exec(text)?.[1]?.trim() || null;
  }).pipe(Effect.orElseSucceed(() => null));

/**
 * Compares two dotted versions numerically ("1.66.9" < "1.66.10"). Used to
 * break an mtime tie between release result files written inside one
 * millisecond: the higher version was the later run.
 */
export function compareHbotsVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
