// @effect-diagnostics nodeBuiltinImport:off - The publish script runs on the build machine.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  atomicWriteFile,
  publishRelease,
  pruneReleases,
  readPublishedRelease,
  readbackOriginProblem,
  releaseProblems,
  sha256File,
  type LatestRecord,
  type ReleaseArtifact,
  type ReleaseCheck,
} from "./androidRelease.ts";
import { requireReleaseVersion } from "./versionCode.ts";

const TMP = NodePath.join(process.cwd(), ".tmp");
const roots: string[] = [];

const tempRoot = () => {
  NodeFS.mkdirSync(TMP, { recursive: true });
  const root = NodeFS.mkdtempSync(NodePath.join(TMP, "android-release-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const artifactFor = (overrides: Partial<ReleaseArtifact> = {}): ReleaseArtifact => ({
  path: "/tmp/hbots.apk",
  version: requireReleaseVersion("1.66.110", "test"),
  packageName: "com.haroutb5.hbots",
  sha256: "a".repeat(64),
  size: 1_200_000,
  signers: ["b".repeat(64)],
  ...overrides,
});

const checkFor = (overrides: Partial<ReleaseCheck> = {}): ReleaseCheck => ({
  artifact: artifactFor(),
  expectedVersion: "1.66.110",
  pinnedSha256: "b".repeat(64),
  published: null,
  minimumNativeVersion: null,
  notes: "Update screen fixes",
  ...overrides,
});

const recordFor = (version: string, sha256: string): LatestRecord => ({
  schema: 1,
  version,
  sha256,
  size: 1_200_000,
  notes: "Update screen fixes",
});

describe("releaseProblems", () => {
  it("accepts a signed, newer APK", () => {
    expect(releaseProblems(checkFor())).toEqual([]);
  });

  it("refuses an APK for another package", () => {
    expect(
      releaseProblems(checkFor({ artifact: artifactFor({ packageName: "com.example.other" }) })),
    ).toEqual(["package is com.example.other, expected com.haroutb5.hbots"]);
  });

  it("refuses a versionName that differs from the release file", () => {
    expect(releaseProblems(checkFor({ expectedVersion: "1.66.111" }))).toEqual([
      "versionName is 1.66.110, expected app-version.txt 1.66.111",
    ]);
  });

  it("refuses an unsigned or debug-signed APK", () => {
    expect(
      releaseProblems(checkFor({ artifact: artifactFor({ signers: ["c".repeat(64)] }) })),
    ).toEqual([`signer ${"c".repeat(64)} does not match release-cert.sha256 ${"b".repeat(64)}`]);
    expect(releaseProblems(checkFor({ artifact: artifactFor({ signers: [] }) }))).toEqual([
      "expected one signer, found 0",
    ]);
    expect(
      releaseProblems(
        checkFor({ artifact: artifactFor({ signers: ["b".repeat(64), "b".repeat(64)] }) }),
      ),
    ).toEqual(["expected one signer, found 2"]);
  });

  it("refuses a versionCode that does not rise above the published one", () => {
    expect(releaseProblems(checkFor({ published: recordFor("1.66.110", "a".repeat(64)) }))).toEqual(
      ["versionCode 1066110 does not increase on published 1.66.110 (1066110)"],
    );
    expect(releaseProblems(checkFor({ published: recordFor("1.66.109", "a".repeat(64)) }))).toEqual(
      [],
    );
  });

  it("refuses a minimum native version above the APK", () => {
    expect(
      releaseProblems(
        checkFor({ minimumNativeVersion: requireReleaseVersion("1.66.111", "test") }),
      ),
    ).toEqual(["minimumNativeVersion 1.66.111 is above published 1.66.110"]);
    expect(
      releaseProblems(
        checkFor({ minimumNativeVersion: requireReleaseVersion("1.66.110", "test") }),
      ),
    ).toEqual([]);
  });

  it("refuses empty or oversized notes", () => {
    expect(releaseProblems(checkFor({ notes: "  " }))).toEqual(["notes are empty"]);
    expect(releaseProblems(checkFor({ notes: "x".repeat(501) }))).toEqual([
      "notes are 501 characters, limit 500",
    ]);
  });
});

describe("readPublishedRelease", () => {
  it("has no release before the first publish", () => {
    expect(readPublishedRelease(NodePath.join(tempRoot(), "android-updates"))).toBeNull();
  });

  it("reads the record the server decodes", () => {
    const dir = NodePath.join(tempRoot(), "android-updates");
    NodeFS.mkdirSync(dir);
    const record = recordFor("1.66.110", "a".repeat(64));
    NodeFS.writeFileSync(NodePath.join(dir, "latest.json"), JSON.stringify(record));
    expect(readPublishedRelease(dir)).toEqual(record);
  });

  it("refuses an unknown schema instead of guessing", () => {
    const dir = NodePath.join(tempRoot(), "android-updates");
    NodeFS.mkdirSync(dir);
    NodeFS.writeFileSync(
      NodePath.join(dir, "latest.json"),
      JSON.stringify({ ...recordFor("1.66.110", "a".repeat(64)), schema: 2 }),
    );
    expect(() => readPublishedRelease(dir)).toThrow(/schema is not 1/u);
  });
});

describe("atomicWriteFile", () => {
  it("keeps the old file when the write fails halfway", () => {
    const root = tempRoot();
    const destination = NodePath.join(root, "latest.json");
    NodeFS.writeFileSync(destination, "old");
    expect(() =>
      atomicWriteFile(destination, (fd) => {
        NodeFS.writeSync(fd, "partial");
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(NodeFS.readFileSync(destination, "utf8")).toBe("old");
    expect(NodeFS.existsSync(`${destination}.tmp`)).toBe(false);
  });

  it("replaces the file on success", () => {
    const root = tempRoot();
    const destination = NodePath.join(root, "latest.json");
    NodeFS.writeFileSync(destination, "old");
    atomicWriteFile(destination, (fd) => NodeFS.writeSync(fd, "new"));
    expect(NodeFS.readFileSync(destination, "utf8")).toBe("new");
  });
});

describe("publishRelease", () => {
  const apkBytes = Buffer.alloc(64, 7);
  const apkFor = (root: string) => {
    const apk = NodePath.join(root, "app-release.apk");
    NodeFS.writeFileSync(apk, apkBytes);
    return apk;
  };

  it("writes the APK and then the manifest the server reads", () => {
    const root = tempRoot();
    const apk = apkFor(root);
    const updates = NodePath.join(root, "android-updates");
    const record = recordFor("1.66.110", sha256File(apk));
    const written = publishRelease(updates, apk, record);
    expect(NodeFS.readFileSync(written.apkPath)).toEqual(apkBytes);
    expect(JSON.parse(NodeFS.readFileSync(written.manifestPath, "utf8"))).toEqual(record);
  });

  it("converges when the same version is published twice", () => {
    const root = tempRoot();
    const apk = apkFor(root);
    const updates = NodePath.join(root, "android-updates");
    const record = recordFor("1.66.110", sha256File(apk));
    publishRelease(updates, apk, record);
    expect(publishRelease(updates, apk, record).pruned).toEqual([]);
  });

  it("refuses to replace an APK for the same version with other bytes", () => {
    const root = tempRoot();
    const apk = apkFor(root);
    const updates = NodePath.join(root, "android-updates");
    publishRelease(updates, apk, recordFor("1.66.110", sha256File(apk)));
    const other = NodePath.join(root, "other.apk");
    NodeFS.writeFileSync(other, Buffer.alloc(64, 9));
    expect(() => publishRelease(updates, other, recordFor("1.66.110", sha256File(other)))).toThrow(
      /already holds different bytes/u,
    );
  });
});

describe("pruneReleases", () => {
  it("keeps the newest three APKs and the current one", () => {
    const root = tempRoot();
    const updates = NodePath.join(root, "android-updates");
    NodeFS.mkdirSync(updates);
    for (const version of ["1.66.108", "1.66.109", "1.66.110", "1.66.111"]) {
      NodeFS.writeFileSync(NodePath.join(updates, `hbots-${version}.apk`), version);
    }
    NodeFS.writeFileSync(NodePath.join(updates, "latest.json"), "{}");
    expect(pruneReleases(updates, "1.66.111")).toEqual(["hbots-1.66.108.apk"]);
    expect(NodeFS.readdirSync(updates).sort()).toEqual([
      "hbots-1.66.109.apk",
      "hbots-1.66.110.apk",
      "hbots-1.66.111.apk",
      "latest.json",
    ]);
  });
});

describe("readbackOriginProblem", () => {
  it("allows https, and http only on loopback", () => {
    expect(readbackOriginProblem("https://hbots.example.com")).toBeNull();
    expect(readbackOriginProblem("http://127.0.0.1:40469")).toBeNull();
    expect(readbackOriginProblem("http://localhost:40469")).toBeNull();
    expect(readbackOriginProblem("http://hbots.example.com")).toBe(
      "readback must use https, or http on 127.0.0.1",
    );
  });
});
