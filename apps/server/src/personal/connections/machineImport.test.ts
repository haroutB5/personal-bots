import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as MachineImport from "./machineImport.ts";

/**
 * Fixture contents only. The locations are injected, so nothing here reads a
 * path the owner's real `gh` or Vercel CLI would use, and the fake filesystem
 * records every path asked for so the test can say which ones were touched.
 */

const GH_PATH = "/fixtures/gh/hosts.yml";
const VERCEL_PATH = "/fixtures/vercel/auth.json";
const VERCEL_CONFIG = "/fixtures/vercel/config.json";

const GH_TOKEN = "gho_fixture_TOKEN_never_real_00000";
const VERCEL_TOKEN = "vercel_fixture_TOKEN_never_real_000";

const GH_HOSTS = `github.com:
    users:
        haroutB5:
            oauth_token: ${GH_TOKEN}
    git_protocol: https
    user: haroutB5
    oauth_token: ${GH_TOKEN}
`;

const NEON_PATH = "/fixtures/neonctl/credentials.json";

const locations: MachineImport.ImportLocations = {
  github: { sourceId: "gh-cli", label: "GitHub CLI", path: GH_PATH },
  vercel: {
    sourceId: "vercel-cli",
    label: "Vercel CLI",
    path: VERCEL_PATH,
    profilePath: VERCEL_CONFIG,
  },
  neon: { sourceId: "neon-cli", label: "Neon CLI", path: NEON_PATH },
  // The Neon and Upstash probes have their own suite; these tests are about
  // the two CLI files, so this one scans no project directories.
  envRoot: null,
};

const harnessFor = (files: Readonly<Record<string, string>>) => {
  const read: Array<string> = [];
  const filesystem = FileSystem.layerNoop({
    exists: (path) => {
      read.push(path);
      return Effect.succeed(Object.hasOwn(files, path));
    },
    readFileString: (path) => {
      read.push(path);
      return Effect.succeed(files[path] ?? "");
    },
  });
  return {
    read,
    layer: MachineImport.layerOf(locations).pipe(Layer.provide(filesystem)),
  };
};

describe("connection machine import", () => {
  const full = harnessFor({
    [GH_PATH]: GH_HOSTS,
    [VERCEL_PATH]: `{"token":"${VERCEL_TOKEN}","type":"token"}`,
    [VERCEL_CONFIG]: `{"email":"harout@example.com"}`,
  });

  it.effect("reports the accounts the CLI files name, and no part of any token", () =>
    Effect.gen(function* () {
      const probe = yield* MachineImport.PersonalConnectionMachineImport;
      const result = yield* probe.probe();
      expect(result.sources.map((source) => [source.sourceId, source.state])).toEqual([
        ["gh-cli", "found"],
        ["vercel-cli", "found"],
        ["neon-cli", "absent"],
      ]);
      expect(result.candidates.map((candidate) => candidate.vendorId)).toEqual([
        "github",
        "vercel",
      ]);
      expect(result.candidates[0]?.identifier).toBe("haroutB5 at github.com");
      expect(result.candidates[1]?.identifier).toBe("harout@example.com");

      // The whole point of a probe: it says what exists, never what it is.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(GH_TOKEN);
      expect(rendered).not.toContain(VERCEL_TOKEN);
      expect(rendered).not.toContain(GH_TOKEN.slice(0, 10));
      expect(rendered).not.toContain(VERCEL_TOKEN.slice(0, 10));

      // Only the configured locations, and nothing near them.
      expect(new Set(full.read)).toEqual(new Set([GH_PATH, VERCEL_PATH, VERCEL_CONFIG, NEON_PATH]));
    }).pipe(Effect.provide(full.layer)),
  );

  it.effect("separates a file that is not there from one it could not read", () =>
    Effect.gen(function* () {
      const probe = yield* MachineImport.PersonalConnectionMachineImport;
      const result = yield* probe.probe();
      const state = (sourceId: string) =>
        result.sources.find((source) => source.sourceId === sourceId)?.state;
      // "Nothing found" is not a failure: the owner may simply not use gh.
      expect(state("gh-cli")).toBe("absent");
      // A file that is there but says nothing usable is a failure worth
      // naming, because "nothing found" would send the owner looking in the
      // wrong place.
      expect(state("vercel-cli")).toBe("unreadable");
      expect(result.candidates).toEqual([]);
    }).pipe(Effect.provide(harnessFor({ [VERCEL_PATH]: "not json at all" }).layer)),
  );

  it.effect("treats a logged-out CLI file as nothing found rather than a failure", () =>
    Effect.gen(function* () {
      const probe = yield* MachineImport.PersonalConnectionMachineImport;
      const result = yield* probe.probe();
      expect(result.sources.find((source) => source.sourceId === "vercel-cli")?.state).toBe(
        "absent",
      );
      expect(result.candidates).toEqual([]);
    }).pipe(Effect.provide(harnessFor({ [VERCEL_PATH]: `{"type":"login"}` }).layer)),
  );

  it.effect("hands the credential straight on without ever returning it to a caller", () =>
    Effect.gen(function* () {
      const probe = yield* MachineImport.PersonalConnectionMachineImport;
      const result = yield* probe.probe();
      const candidateId = result.candidates[0]?.candidateId ?? "";
      const credentials = yield* probe.readCredential(candidateId);
      expect(Object.keys(credentials)).toEqual(["accessToken"]);
      expect(Redacted.value(credentials["accessToken"] ?? Redacted.make(""))).toBe(GH_TOKEN);
    }).pipe(Effect.provide(harnessFor({ [GH_PATH]: GH_HOSTS }).layer)),
  );

  it.effect("refuses a candidate id that names anything but a source it owns", () =>
    Effect.gen(function* () {
      const probe = yield* MachineImport.PersonalConnectionMachineImport;
      // A path cannot be smuggled in through the identifier: candidate ids are
      // matched against the probe's own list, never turned back into a path.
      const error = yield* Effect.flip(probe.readCredential("gh-cli:../../../etc/passwd"));
      expect(error.message).toContain("no longer");
    }).pipe(Effect.provide(harnessFor({ [GH_PATH]: GH_HOSTS }).layer)),
  );

  it.effect("refuses a file too large to be a CLI credential file", () =>
    Effect.gen(function* () {
      const probe = yield* MachineImport.PersonalConnectionMachineImport;
      const result = yield* probe.probe();
      expect(result.sources.find((source) => source.sourceId === "gh-cli")?.state).toBe(
        "unreadable",
      );
      expect(result.candidates).toEqual([]);
    }).pipe(
      Effect.provide(
        harnessFor({ [GH_PATH]: "x".repeat(MachineImport.MAX_SOURCE_BYTES + 1) }).layer,
      ),
    ),
  );
});

describe("connection import parsing", () => {
  it("reads the active account out of a gh hosts file", () => {
    expect(MachineImport.parseGhHosts(GH_HOSTS)).toEqual({
      host: "github.com",
      user: "haroutB5",
      token: GH_TOKEN,
    });
  });

  it("returns nothing for a gh hosts file with no token in it", () => {
    expect(MachineImport.parseGhHosts("github.com:\n    git_protocol: https\n")).toBeNull();
    expect(MachineImport.parseGhHosts("")).toBeNull();
  });

  it("parses rather than evaluates whatever it reads", () => {
    // A shell-shaped value is a string, not something that runs. Nothing in
    // this module executes a file or expands what is in one.
    const hostile = 'github.com:\n    user: "$(rm -rf /)"\n    oauth_token: tok\n';
    expect(MachineImport.parseGhHosts(hostile)).toEqual({
      host: "github.com",
      user: "$(rm -rf /)",
      token: "tok",
    });
  });

  it("tells a logged-out Vercel auth file apart from one it cannot read", () => {
    expect(MachineImport.parseVercelAuth(`{"token":"abc","type":"token"}`)).toEqual({
      _tag: "token",
      token: "abc",
    });
    expect(MachineImport.parseVercelAuth(`{"type":"login"}`)).toEqual({ _tag: "absent" });
    expect(MachineImport.parseVercelAuth("nonsense")).toEqual({ _tag: "unreadable" });
  });
});
