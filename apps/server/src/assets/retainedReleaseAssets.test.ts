import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  findRetainedReleaseAsset,
  isBuildAssetPath,
  releasesDirOf,
} from "./retainedReleaseAssets.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const releases = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-retained-assets-" });
  const clientDir = (sha: string) => path.join(releases, sha, "dist", "client");
  for (const sha of ["active", "older", "oldest"]) {
    yield* fileSystem.makeDirectory(path.join(clientDir(sha), "assets"), { recursive: true });
  }
  yield* fileSystem.writeFileString(path.join(clientDir("oldest"), "assets", "A-11111111.js"), "a");
  yield* fileSystem.writeFileString(path.join(clientDir("active"), "assets", "B-22222222.js"), "b");
  yield* fileSystem.writeFileString(path.join(releases, "current.txt"), "active");
  yield* fileSystem.writeFileString(path.join(releases, "secret.js"), "outside");
  return { path, releases, clientDir };
});

it.effect("finds a chunk in another retained release", () =>
  Effect.gen(function* () {
    const { path, clientDir } = yield* setup;
    const found = yield* findRetainedReleaseAsset(clientDir("active"), "assets/A-11111111.js");
    assert.equal(found, path.join(clientDir("oldest"), "assets", "A-11111111.js"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns null for unknown, nested or escaping paths and never the active release", () =>
  Effect.gen(function* () {
    const { clientDir } = yield* setup;
    const active = clientDir("active");
    for (const relative of [
      "assets/Missing-00000000.js",
      "assets/B-22222222.js",
      "assets/../../secret.js",
      "assets/nested/A-11111111.js",
      "assets/..",
      "index.html",
    ]) {
      assert.isNull(yield* findRetainedReleaseAsset(active, relative), relative);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does nothing outside the release layout", () =>
  Effect.gen(function* () {
    const { path, releases } = yield* setup;
    assert.isNull(releasesDirOf(path.join(releases, "web", "dist"), path));
    assert.isNull(
      yield* findRetainedReleaseAsset(path.join(releases, "web", "dist"), "assets/A-11111111.js"),
    );
    assert.equal(releasesDirOf(path.join(releases, "x", "dist", "client"), path), releases);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("recognises build asset paths", () => {
  assert.isTrue(isBuildAssetPath("assets/x.js"));
  assert.isTrue(isBuildAssetPath("assets/nested/x.js"));
  assert.isFalse(isBuildAssetPath("assetsx/x.js"));
  assert.isFalse(isBuildAssetPath("bots/assets"));
});
