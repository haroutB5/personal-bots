// @effect-diagnostics nodeBuiltinImport:off - resolving the fixed CLI locations is platform path arithmetic done once at layer construction, with no Effect to run it in.
// @effect-diagnostics preferSchemaOverJson:off - CLI credential files are third-party shapes we probe defensively, not contracts we own.
import * as OS from "node:os";
import * as NodePath from "node:path";

import {
  PersonalConnectionsError,
  type PersonalConnectionImportResult,
  type PersonalConnectionImportSource,
  type PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { parse as parseYamlDocument } from "yaml";

import { ServerConfig } from "../../config.ts";
import { connectionDefinition } from "./catalog.ts";

/**
 * Adopting the credentials the owner's own CLIs already hold.
 *
 * Owner-triggered only: no bot-facing tool reaches this. The rules it keeps
 * are narrow on purpose.
 *
 * - Only the fixed locations below are read. No path comes from a request, so
 *   there is nothing to traverse out of; a candidate id is matched against the
 *   probe's own list and is never turned back into a path.
 * - Parsing is bounded and inert. A file is a string that gets parsed, never
 *   sourced, executed or expanded, and one larger than a credential file could
 *   plausibly be is refused rather than parsed.
 * - A probe returns identifiers and states. It never returns a token, a
 *   prefix of one, or its length: adoption re-reads the source here, so
 *   nothing about the value has to cross the wire for the owner to pick it.
 * - Finding a value is not proof it works, so adoption goes through the same
 *   validating connect path a pasted token does.
 * - The CLI's own files are only ever read.
 */

/** Large enough for any real `hosts.yml`, small enough that parsing is cheap. */
export const MAX_SOURCE_BYTES = 256 * 1024;

export interface ImportLocation {
  readonly sourceId: string;
  readonly label: string;
  readonly path: string;
}

/** Enough for any credential file; a longer one is reported, never parsed. */
export const MAX_ENV_LINES = 2_000;

/**
 * The workspace directory personal bots are given, under the server's base
 * directory.
 *
 * Stated here rather than imported from `PersonalBotService`, which would pull
 * the whole bot service into a module that only wants a folder name.
 * `machineImportProvisioning.test.ts` reads both files and asserts they still
 * agree, so a rename cannot leave this probe silently scanning nothing.
 */
export const PERSONAL_WORKSPACE_DIRNAME = "personal-workspace";

/** A cap on how many project directories one scan will look inside. */
export const MAX_ENV_ROOTS = 25;

export interface ImportLocations {
  readonly github: ImportLocation;
  /** The Vercel CLI keeps the token and the profile in two files beside each other. */
  readonly vercel: ImportLocation & { readonly profilePath: string };
  readonly neon: ImportLocation;
  /**
   * The directory whose immediate children are scanned for a `.env.local`, or
   * `null` for no scan at all.
   *
   * It is the personal workspace — the one place on this machine the bots
   * themselves work, and so the one set of project roots the owner registered
   * by using them. No path comes from a request here either: the root is
   * computed at layer construction and the children come from our own
   * listing, one level deep. Nothing elsewhere on the machine is followed,
   * which is exactly why the owner's other projects are out of this probe's
   * reach.
   */
  readonly envRoot: string | null;
}

export interface GhHostsAccount {
  readonly host: string;
  readonly user: string;
  readonly token: string;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The active account in a `gh` CLI hosts file. Only the top-level host entry
 * is read: the nested `users` map is a history of accounts the owner has
 * signed in as, and adopting one of those would connect an account they are
 * not currently using.
 */
export const parseGhHosts = (text: string): GhHostsAccount | null => {
  const document = ((): unknown => {
    try {
      return parseYamlDocument(text);
    } catch {
      return null;
    }
  })();
  for (const [host, value] of Object.entries(asRecord(document))) {
    const entry = asRecord(value);
    const token = asString(entry["oauth_token"]);
    if (token.length === 0) continue;
    return { host, user: asString(entry["user"]), token };
  }
  return null;
};

export type VercelAuth =
  | { readonly _tag: "token"; readonly token: string }
  /** The file is fine and holds no token: a logged-out CLI, not a failure. */
  | { readonly _tag: "absent" }
  | { readonly _tag: "unreadable" };

/** The same three answers for any single-token credential file. */
export type CredentialFileState = VercelAuth;

export const parseVercelAuth = (text: string): VercelAuth => {
  const document = ((): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (document === undefined) return { _tag: "unreadable" };
  const token = asString(asRecord(document)["token"]);
  return token.length === 0 ? { _tag: "absent" } : { _tag: "token", token };
};

/**
 * The Neon CLI's stored login.
 *
 * `neonctl` writes an OIDC token set, and uses its `access_token` as the API
 * key for exactly the management API this build calls, so it is adoptable as
 * one. Nothing here says whose account it is or whether it has expired;
 * adoption calls Neon and finds out, which is the only answer worth having.
 */
export const parseNeonCredentials = (text: string): CredentialFileState => {
  const document = ((): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (document === undefined) return { _tag: "unreadable" };
  const token = asString(asRecord(document)["access_token"]);
  return token.length === 0 ? { _tag: "absent" } : { _tag: "token", token };
};

/**
 * A `.env` file as a flat map, bounded and inert.
 *
 * Nothing is executed, sourced or expanded: `$(...)`, backticks and `${VAR}`
 * stay the literal characters they are, and a line that is not a plain
 * assignment to a plain name is skipped rather than guessed at.
 */
export const parseEnvFile = (text: string): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(0, MAX_ENV_LINES)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const raw = assignment.slice(separator + 1).trim();
    const quoted =
      raw.length > 1 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    values[key] = quoted ? raw.slice(1, -1) : raw;
  }
  return values;
};

/** The email the Vercel CLI records beside the token, for the owner to recognise. */
export const parseVercelProfile = (text: string): string | null => {
  try {
    const email = asString(asRecord(JSON.parse(text) as unknown)["email"]);
    return email.length === 0 ? null : email;
  } catch {
    return null;
  }
};

/**
 * Where the two CLIs keep their credentials on this machine.
 *
 * `gh` follows XDG on every platform but Windows, where it uses the roaming
 * profile; the Vercel CLI uses an `xdg.data` directory under the same roaming
 * profile, which is where it lives on the owner's box.
 */
export const defaultLocations = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  envRoot: string | null = null,
): ImportLocations => {
  const home = env["HOME"] ?? OS.homedir();
  const appData = env["APPDATA"] ?? NodePath.join(home, "AppData", "Roaming");
  const ghRoot =
    platform === "win32"
      ? NodePath.join(appData, "GitHub CLI")
      : NodePath.join(env["XDG_CONFIG_HOME"] ?? NodePath.join(home, ".config"), "gh");
  const vercelRoot =
    platform === "win32"
      ? NodePath.join(appData, "xdg.data", "com.vercel.cli")
      : NodePath.join(
          env["XDG_DATA_HOME"] ?? NodePath.join(home, ".local", "share"),
          "com.vercel.cli",
        );
  return {
    github: {
      sourceId: "gh-cli",
      label: "GitHub CLI",
      path: NodePath.join(ghRoot, "hosts.yml"),
    },
    vercel: {
      sourceId: "vercel-cli",
      label: "Vercel CLI",
      path: NodePath.join(vercelRoot, "auth.json"),
      profilePath: NodePath.join(vercelRoot, "config.json"),
    },
    neon: {
      sourceId: "neon-cli",
      label: "Neon CLI",
      // `neonctl` follows XDG on every platform, Windows included, which is
      // why this one does not branch the way the other two do.
      path: NodePath.join(
        env["XDG_CONFIG_HOME"] ?? NodePath.join(home, ".config"),
        "neonctl",
        "credentials.json",
      ),
    },
    envRoot,
  };
};

export class PersonalConnectionMachineImport extends Context.Service<
  PersonalConnectionMachineImport,
  {
    readonly probe: () => Effect.Effect<PersonalConnectionImportResult, PersonalConnectionsError>;
    /**
     * Re-reads the source behind a candidate. Internal only: the value goes
     * straight into the connect path and is never part of an RPC reply.
     */
    readonly readCredential: (
      candidateId: string,
    ) => Effect.Effect<
      Readonly<Record<string, Redacted.Redacted<string>>>,
      PersonalConnectionsError
    >;
  }
>()("t3/personal/connections/machineImport/PersonalConnectionMachineImport") {}

interface Found {
  readonly source: PersonalConnectionImportSource;
  readonly candidate: PersonalConnectionImportResult["candidates"][number] | null;
  readonly credentials: Readonly<Record<string, Redacted.Redacted<string>>> | null;
}

export const makeWith = (locations: ImportLocations) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    /** Absent, too big, or the text. Never throws a path back at the caller. */
    const readBounded = Effect.fn("MachineImport.readBounded")(function* (path: string) {
      const present = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
      if (!present) return { _tag: "absent" as const };
      const text = yield* fs.readFileString(path).pipe(
        Effect.map((value) => ({ _tag: "text" as const, text: value })),
        Effect.orElseSucceed(() => ({ _tag: "unreadable" as const })),
      );
      if (text._tag === "unreadable") return text;
      return Buffer.byteLength(text.text, "utf8") > MAX_SOURCE_BYTES
        ? { _tag: "unreadable" as const }
        : text;
    });

    const describe = (
      location: ImportLocation,
      vendorId: PersonalConnectionVendorId,
      state: PersonalConnectionImportSource["state"],
      detail: string | null,
    ): PersonalConnectionImportSource => ({
      sourceId: location.sourceId,
      vendorId,
      label: location.label,
      state,
      detail,
    });

    const probeGithub = Effect.fn("MachineImport.probeGithub")(function* () {
      const location = locations.github;
      const read = yield* readBounded(location.path);
      if (read._tag === "absent") {
        return {
          source: describe(location, "github", "absent", "No GitHub CLI login on this machine."),
          candidate: null,
          credentials: null,
        };
      }
      if (read._tag === "unreadable") {
        return {
          source: describe(
            location,
            "github",
            "unreadable",
            "The GitHub CLI config is there but could not be read.",
          ),
          candidate: null,
          credentials: null,
        };
      }
      const account = parseGhHosts(read.text);
      if (account === null) {
        return {
          source: describe(
            location,
            "github",
            "absent",
            "The GitHub CLI is installed but not signed in.",
          ),
          candidate: null,
          credentials: null,
        };
      }
      return {
        source: describe(location, "github", "found", null),
        candidate: {
          candidateId: `${location.sourceId}:${account.host}`,
          vendorId: "github" as const,
          sourceLabel: location.label,
          identifier: `${account.user} at ${account.host}`,
        },
        credentials: { accessToken: Redacted.make(account.token) },
      };
    });

    const probeVercel = Effect.fn("MachineImport.probeVercel")(function* () {
      const location = locations.vercel;
      const read = yield* readBounded(location.path);
      if (read._tag !== "text") {
        return {
          source: describe(
            location,
            "vercel",
            read._tag,
            read._tag === "absent"
              ? "No Vercel CLI login on this machine."
              : "The Vercel CLI credential file is there but could not be read.",
          ),
          candidate: null,
          credentials: null,
        };
      }
      const auth = parseVercelAuth(read.text);
      if (auth._tag !== "token") {
        return {
          source: describe(
            location,
            "vercel",
            auth._tag,
            auth._tag === "absent"
              ? "The Vercel CLI is installed but not signed in."
              : "The Vercel CLI credential file could not be parsed.",
          ),
          candidate: null,
          credentials: null,
        };
      }
      const profile = yield* readBounded(location.profilePath);
      return {
        source: describe(location, "vercel", "found", null),
        candidate: {
          candidateId: `${location.sourceId}:token`,
          vendorId: "vercel" as const,
          sourceLabel: location.label,
          identifier: profile._tag === "text" ? parseVercelProfile(profile.text) : null,
        },
        credentials: { accessToken: Redacted.make(auth.token) },
      };
    });

    const probeNeon = Effect.fn("MachineImport.probeNeon")(function* () {
      const location = locations.neon;
      const read = yield* readBounded(location.path);
      if (read._tag !== "text") {
        return {
          source: describe(
            location,
            "neon",
            read._tag,
            read._tag === "absent"
              ? "No Neon CLI login on this machine."
              : "The Neon CLI credential file is there but could not be read.",
          ),
          candidate: null,
          credentials: null,
        };
      }
      const auth = parseNeonCredentials(read.text);
      if (auth._tag !== "token") {
        return {
          source: describe(
            location,
            "neon",
            auth._tag,
            auth._tag === "absent"
              ? "The Neon CLI is installed but not signed in."
              : "The Neon CLI credential file could not be parsed.",
          ),
          candidate: null,
          credentials: null,
        };
      }
      return {
        source: describe(location, "neon", "found", null),
        candidate: {
          candidateId: `${location.sourceId}:credentials`,
          vendorId: "neon" as const,
          sourceLabel: location.label,
          // The file names no account and the token is not read for one.
          // Adopting it asks Neon, which is the only answer worth having.
          identifier: null,
        },
        credentials: { apiKey: Redacted.make(auth.token) },
      };
    });

    /**
     * Upstash credentials sitting in a project's own `.env.local`.
     *
     * Only the management pair is adoptable. A file holding the REST URL and
     * token instead is reported as found with that said plainly: those are an
     * application's credentials for one database and cannot create another,
     * and letting the owner adopt them would fail at validation with a message
     * about the wrong thing.
     */
    const probeEnvFile = Effect.fn("MachineImport.probeEnvFile")(function* (input: {
      readonly directory: string;
      readonly label: string;
      readonly sourceId: string;
    }) {
      const location: ImportLocation = {
        sourceId: input.sourceId,
        label: input.label,
        path: NodePath.join(input.directory, ".env.local"),
      };
      const read = yield* readBounded(location.path);
      // A project with no `.env.local` is not a place the owner was looking:
      // listing one row per directory would bury the two that matter.
      if (read._tag === "absent") return null;
      if (read._tag !== "text") {
        const unreadable: Found = {
          source: describe(
            location,
            "upstash",
            read._tag,
            "This project's .env.local is there but could not be read.",
          ),
          candidate: null,
          credentials: null,
        };
        return unreadable;
      }
      const values = parseEnvFile(read.text);
      const email = values["UPSTASH_EMAIL"] ?? "";
      const apiKey = values["UPSTASH_API_KEY"] ?? "";
      if (email.length === 0 || apiKey.length === 0) {
        const hasRest =
          (values["UPSTASH_REDIS_REST_TOKEN"] ?? values["KV_REST_API_TOKEN"] ?? "").length > 0;
        const notAdoptable: Found = {
          source: describe(
            location,
            "upstash",
            hasRest ? "found" : "absent",
            hasRest
              ? "This project's .env.local holds a Redis REST URL and token. Those belong to one database and cannot create or delete any, so they are not offered here. An account API key from the Upstash console is what hbots needs."
              : "This project's .env.local holds no Upstash credentials.",
          ),
          candidate: null,
          credentials: null,
        };
        return notAdoptable;
      }
      const adoptable: Found = {
        source: describe(location, "upstash", "found", null),
        candidate: {
          candidateId: `${location.sourceId}:upstash`,
          vendorId: "upstash" as const,
          sourceLabel: input.label,
          identifier: email,
        },
        credentials: { email: Redacted.make(email), apiKey: Redacted.make(apiKey) },
      };
      return adoptable;
    });

    /**
     * The project directories to look in: the workspace itself and its
     * immediate children, in a stable order and capped. One level only —
     * a recursive walk of a directory the bots write into is an unbounded
     * scan of whatever they happened to create.
     */
    const envDirectories = Effect.fn("MachineImport.envDirectories")(function* () {
      const root = locations.envRoot;
      if (root === null) return [] as ReadonlyArray<{ directory: string; label: string }>;
      const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      return [
        { directory: root, label: "Workspace" },
        ...entries
          .filter((entry) => !entry.startsWith("."))
          .toSorted()
          .map((entry) => ({ directory: NodePath.join(root, entry), label: entry })),
      ].slice(0, MAX_ENV_ROOTS);
    });

    const scan = Effect.fn("MachineImport.scan")(function* () {
      const directories = yield* envDirectories();
      const envFiles = yield* Effect.forEach(directories, (entry) =>
        probeEnvFile({
          directory: entry.directory,
          label: entry.label,
          // Derived from our own listing and matched back against it, never
          // turned into a path again.
          sourceId: `env-local:${entry.label}`,
        }),
      );
      const found: ReadonlyArray<Found> = [
        yield* probeGithub(),
        yield* probeVercel(),
        yield* probeNeon(),
        ...envFiles.filter((entry) => entry !== null),
      ];
      return found;
    });

    const probe: PersonalConnectionMachineImport["Service"]["probe"] = () =>
      scan().pipe(
        Effect.map((found) => ({
          sources: found.map((entry) => entry.source),
          candidates: found.flatMap((entry) => (entry.candidate === null ? [] : [entry.candidate])),
        })),
      );

    const readCredential: PersonalConnectionMachineImport["Service"]["readCredential"] = (
      candidateId,
    ) =>
      scan().pipe(
        Effect.flatMap((found) => {
          // Matched against what the probe just found, so an id the owner did
          // not receive from us names nothing and reaches no filesystem.
          const match = found.find((entry) => entry.candidate?.candidateId === candidateId);
          return match?.credentials === undefined || match.credentials === null
            ? Effect.fail(
                new PersonalConnectionsError({
                  message:
                    "That saved login is no longer on this machine. Run the probe again and pick from what it finds.",
                }),
              )
            : Effect.succeed(match.credentials);
        }),
      );

    return PersonalConnectionMachineImport.of({ probe, readCredential });
  });

export const layerOf = (locations: ImportLocations) =>
  Layer.effect(PersonalConnectionMachineImport, makeWith(locations));

/**
 * The live locations. The env-file root is the personal workspace, read from
 * the server's own configuration rather than from anything a caller sends, so
 * the set of directories this can look in is fixed when the layer is built.
 */
export const layer = Layer.effect(
  PersonalConnectionMachineImport,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeWith(
      defaultLocations(
        process.env,
        process.platform,
        NodePath.join(config.baseDir, PERSONAL_WORKSPACE_DIRNAME),
      ),
    );
  }),
);

/** The vendors this milestone can import, for the screen that offers it. */
export const IMPORTABLE_VENDORS: ReadonlyArray<PersonalConnectionVendorId> = [
  "github",
  "vercel",
  "neon",
  "upstash",
];

export const importableVendorNames = () =>
  IMPORTABLE_VENDORS.map((vendorId) => connectionDefinition(vendorId).displayName);
