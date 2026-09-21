// @effect-diagnostics nodeBuiltinImport:off - this suite reads its own source tree to compare two literals, and builds fixture paths the way the probe does.
// @effect-diagnostics preferSchemaOverJson:off - the fixtures stand in for third-party CLI files, which are arbitrary JSON we probe defensively.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as MachineImport from "./machineImport.ts";

/**
 * The Neon and Upstash import probes.
 *
 * Fixture contents only, through an injected filesystem that records every
 * path asked for. Nothing here reads a location the owner's real CLIs use.
 */

const GH_PATH = "/fixtures/gh/hosts.yml";
const VERCEL_PATH = "/fixtures/vercel/auth.json";
const VERCEL_CONFIG = "/fixtures/vercel/config.json";
const NEON_PATH = "/fixtures/neonctl/credentials.json";
const ENV_ROOT = "/fixtures/workspace";

const NEON_TOKEN = "neon_fixture_TOKEN_never_real_000";
const UPSTASH_KEY = "upstash_fixture_APIKEY_never_real_0";
const UPSTASH_REST_TOKEN = "AX9fAAIncDE_fixture_REST_never_real";

/** Built the way the probe builds it, so this fixture matches on any platform. */
const envFile = (project?: string) =>
  project === undefined
    ? NodePath.join(ENV_ROOT, ".env.local")
    : NodePath.join(ENV_ROOT, project, ".env.local");

const text = (value: unknown) =>
  NodeUtil.inspect(value, {
    depth: null,
    breakLength: Infinity,
    maxArrayLength: null,
    maxStringLength: null,
  });

const locationsWith = (envRoot: string | null): MachineImport.ImportLocations => ({
  github: { sourceId: "gh-cli", label: "GitHub CLI", path: GH_PATH },
  vercel: {
    sourceId: "vercel-cli",
    label: "Vercel CLI",
    path: VERCEL_PATH,
    profilePath: VERCEL_CONFIG,
  },
  neon: { sourceId: "neon-cli", label: "Neon CLI", path: NEON_PATH },
  envRoot,
});

const harnessFor = (input: {
  readonly files: Readonly<Record<string, string>>;
  readonly directories?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly envRoot?: string | null;
}) => {
  const read: Array<string> = [];
  const filesystem = FileSystem.layerNoop({
    exists: (path) => {
      read.push(path);
      return Effect.succeed(Object.hasOwn(input.files, path));
    },
    readFileString: (path) => {
      read.push(path);
      return Effect.succeed(input.files[path] ?? "");
    },
    readDirectory: (path) => {
      read.push(path);
      const entries = input.directories?.[path];
      return entries === undefined
        ? Effect.die(`the probe listed a directory it was not given: ${path}`)
        : Effect.succeed([...entries]);
    },
  });
  return {
    read,
    layer: MachineImport.layerOf(
      locationsWith(input.envRoot === undefined ? ENV_ROOT : input.envRoot),
    ).pipe(Layer.provide(filesystem)),
  };
};

describe("neon import probe", () => {
  it.effect("offers the Neon CLI login without saying anything about the token", () =>
    Effect.gen(function* () {
      const harness = harnessFor({
        files: {
          [NEON_PATH]: JSON.stringify({
            access_token: NEON_TOKEN,
            refresh_token: `${NEON_TOKEN}-refresh`,
            expires_at: 1,
          }),
        },
        directories: { [ENV_ROOT]: [] },
      });
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const result = yield* probe.probe();
        const neon = result.candidates.find((candidate) => candidate.vendorId === "neon");
        expect(neon?.candidateId).toBe("neon-cli:credentials");
        // The file names no account, and the token is not read for one.
        expect(neon?.identifier).toBeNull();
        const serialised = text(result);
        expect(serialised).not.toContain(NEON_TOKEN);
        expect(serialised).not.toContain(NEON_TOKEN.slice(0, 10));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reads the token only on adoption, as the API key the adapter wants", () =>
    Effect.gen(function* () {
      const harness = harnessFor({
        files: { [NEON_PATH]: JSON.stringify({ access_token: NEON_TOKEN }) },
        directories: { [ENV_ROOT]: [] },
      });
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const credentials = yield* probe.readCredential("neon-cli:credentials");
        // `apiKey` is the field the Neon connection stores and the adapter
        // reads; neonctl's access token is used as exactly that.
        expect(Redacted.value(credentials["apiKey"] ?? Redacted.make(""))).toBe(NEON_TOKEN);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("separates a signed-out CLI from one whose file makes no sense", () =>
    Effect.gen(function* () {
      const signedOut = harnessFor({
        files: { [NEON_PATH]: JSON.stringify({ expires_at: 1 }) },
        directories: { [ENV_ROOT]: [] },
      });
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const result = yield* probe.probe();
        const source = result.sources.find((entry) => entry.sourceId === "neon-cli");
        expect(source?.state).toBe("absent");
        expect(source?.detail).toContain("not signed in");
      }).pipe(Effect.provide(signedOut.layer));

      const broken = harnessFor({
        files: { [NEON_PATH]: "not json at all" },
        directories: { [ENV_ROOT]: [] },
      });
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const result = yield* probe.probe();
        const source = result.sources.find((entry) => entry.sourceId === "neon-cli");
        expect(source?.state).toBe("unreadable");
      }).pipe(Effect.provide(broken.layer));
    }),
  );
});

describe("upstash env-file import probe", () => {
  const envHarness = (files: Readonly<Record<string, string>>, entries: ReadonlyArray<string>) =>
    harnessFor({ files, directories: { [ENV_ROOT]: [...entries] } });

  it.effect("offers the account pair a project's .env.local holds, and no part of it", () =>
    Effect.gen(function* () {
      const harness = envHarness(
        {
          [envFile("hbots-demo")]: [
            "# upstash",
            "export UPSTASH_EMAIL=harout@example.com",
            `UPSTASH_API_KEY="${UPSTASH_KEY}"`,
            `UPSTASH_REDIS_REST_TOKEN=${UPSTASH_REST_TOKEN}`,
          ].join("\n"),
        },
        ["hbots-demo"],
      );
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const result = yield* probe.probe();
        const upstash = result.candidates.find((candidate) => candidate.vendorId === "upstash");
        expect(upstash?.candidateId).toBe("env-local:hbots-demo:upstash");
        // The email is the owner's own, and is how they recognise the row.
        expect(upstash?.identifier).toBe("harout@example.com");
        const serialised = text(result);
        expect(serialised).not.toContain(UPSTASH_KEY);
        expect(serialised).not.toContain(UPSTASH_KEY.slice(0, 10));
        expect(serialised).not.toContain(UPSTASH_REST_TOKEN);

        const credentials = yield* probe.readCredential("env-local:hbots-demo:upstash");
        expect(Redacted.value(credentials["email"] ?? Redacted.make(""))).toBe(
          "harout@example.com",
        );
        expect(Redacted.value(credentials["apiKey"] ?? Redacted.make(""))).toBe(UPSTASH_KEY);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("will not offer an application REST credential that cannot provision anything", () =>
    Effect.gen(function* () {
      const harness = envHarness(
        {
          [envFile("hbots-demo")]: [
            "UPSTASH_REDIS_REST_URL=https://eu1-fixture.upstash.io",
            `UPSTASH_REDIS_REST_TOKEN=${UPSTASH_REST_TOKEN}`,
          ].join("\n"),
        },
        ["hbots-demo"],
      );
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const result = yield* probe.probe();
        expect(result.candidates.some((candidate) => candidate.vendorId === "upstash")).toBe(false);
        const source = result.sources.find((entry) => entry.sourceId === "env-local:hbots-demo");
        // Found, and said plainly: the owner is told what is there and why it
        // is no use, rather than being offered a value that fails validation.
        expect(source?.state).toBe("found");
        expect(source?.detail).toContain("cannot create or delete");
        expect(text(result)).not.toContain(UPSTASH_REST_TOKEN);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("parses nothing it finds: a shell fragment stays a string", () =>
    Effect.gen(function* () {
      const harness = envHarness(
        {
          [envFile("hbots-demo")]: [
            "UPSTASH_EMAIL=harout@example.com",
            'UPSTASH_API_KEY="$(rm -rf /)"',
          ].join("\n"),
        },
        ["hbots-demo"],
      );
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const credentials = yield* probe.readCredential("env-local:hbots-demo:upstash");
        expect(Redacted.value(credentials["apiKey"] ?? Redacted.make(""))).toBe("$(rm -rf /)");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("looks in the workspace and its immediate children, and nowhere else", () =>
    Effect.gen(function* () {
      const harness = envHarness({}, ["hbots-demo", "nested", ".git"]);
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        yield* probe.probe();
      }).pipe(Effect.provide(harness.layer));
      const envPaths = harness.read.filter((path) => path.endsWith(".env.local"));
      expect(envPaths.toSorted()).toEqual(
        [envFile(), envFile("hbots-demo"), envFile("nested")].toSorted(),
      );
      // One level only, and dot-directories are not projects.
      expect(harness.read.some((path) => path.includes(".git"))).toBe(false);
      expect(harness.read.filter((path) => path === ENV_ROOT)).toHaveLength(1);
    }),
  );

  it.effect("scans nothing at all when there is no workspace root configured", () =>
    Effect.gen(function* () {
      const harness = harnessFor({ files: {}, envRoot: null });
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const result = yield* probe.probe();
        expect(result.sources.every((entry) => !entry.sourceId.startsWith("env-local"))).toBe(true);
      }).pipe(Effect.provide(harness.layer));
      // `readDirectory` would have died; not calling it is the point.
      expect(harness.read).not.toContain(ENV_ROOT);
    }),
  );

  it.effect("refuses a candidate id the probe did not hand out", () =>
    Effect.gen(function* () {
      const harness = envHarness(
        {
          [envFile("hbots-demo")]: `UPSTASH_EMAIL=a@b.c\nUPSTASH_API_KEY=${UPSTASH_KEY}`,
        },
        ["hbots-demo"],
      );
      yield* Effect.gen(function* () {
        const probe = yield* MachineImport.PersonalConnectionMachineImport;
        const error = yield* Effect.flip(
          probe.readCredential("env-local:../../../etc/passwd:upstash"),
        );
        expect(error.message).toContain("no longer on this machine");
      }).pipe(Effect.provide(harness.layer));
      // A candidate id is matched against what the probe found; it is never
      // turned back into a path, so there was nothing to traverse.
      expect(harness.read.some((path) => path.includes("passwd"))).toBe(false);
    }),
  );
});

describe("the workspace directory name", () => {
  it("still matches the one the bot service creates", () => {
    // Stated in two places so this probe does not drag the bot service into
    // its module graph. If one is renamed, this fails rather than the probe
    // silently scanning a directory that does not exist.
    const source = NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL("../PersonalBotService.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain(
      `PERSONAL_WORKSPACE_DIRNAME = "${MachineImport.PERSONAL_WORKSPACE_DIRNAME}"`,
    );
  });
});
