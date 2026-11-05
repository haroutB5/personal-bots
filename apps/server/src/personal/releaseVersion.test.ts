import * as NodeServices from "@t3tools/shared/nodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { compareHbotsVersions, readLiveHbotsVersion } from "./releaseVersion.ts";

it.effect("reads the served release stamp, and null when there is none", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-release-version-" });
    const stamp = (text: string) =>
      fileSystem
        .writeFileString(path.join(staticDir, "version.txt"), text)
        .pipe(Effect.andThen(readLiveHbotsVersion(staticDir)));

    assert.equal(yield* readLiveHbotsVersion(undefined), null);
    assert.equal(yield* readLiveHbotsVersion(staticDir), null);
    assert.equal(yield* stamp("no version line here\n"), null);
    assert.equal(yield* stamp("version=\n"), null);
    assert.equal(yield* stamp("version=1.66.110\n"), "1.66.110");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("orders release versions numerically", () =>
  Effect.sync(() => {
    assert.equal(compareHbotsVersions("1.66.10", "1.66.9"), 1);
    assert.equal(compareHbotsVersions("1.66.9", "1.66.10"), -1);
    assert.equal(compareHbotsVersions("1.67.0", "1.66.99"), 1);
    assert.equal(compareHbotsVersions("1.66.110", "1.66.110"), 0);
    assert.equal(compareHbotsVersions("1.66", "1.66.0"), 0);
  }),
);
