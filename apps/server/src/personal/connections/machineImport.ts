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

export interface ImportLocations {
  readonly github: ImportLocation;
  /** The Vercel CLI keeps the token and the profile in two files beside each other. */
  readonly vercel: ImportLocation & { readonly profilePath: string };
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

    const scan = Effect.fn("MachineImport.scan")(function* () {
      const found: ReadonlyArray<Found> = [yield* probeGithub(), yield* probeVercel()];
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

export const layer = layerOf(defaultLocations());

/** The vendors this milestone can import, for the screen that offers it. */
export const IMPORTABLE_VENDORS: ReadonlyArray<PersonalConnectionVendorId> = ["github", "vercel"];

export const importableVendorNames = () =>
  IMPORTABLE_VENDORS.map((vendorId) => connectionDefinition(vendorId).displayName);
