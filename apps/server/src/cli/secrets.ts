// @effect-diagnostics nodeBuiltinImport:off - the CLI reads one stdin line with plain fs.
/**
 * `t3 secrets export|import|status|rewrap`. The passphrase and the old
 * machine's material come from environment variables, never from arguments.
 * Nothing here prints a secret value, a passphrase or key material.
 */
import * as NodeFS from "node:fs";

import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";

import {
  MIN_PASSPHRASE_LENGTH,
  SecretsPortabilityError,
  exportSecretsBundle,
  importSecretsBundle,
  inspectSealedStore,
  rewrapDataKey,
} from "../personal/secrets/secretsPortability.ts";

export const PASSPHRASE_ENV = "HBOTS_SECRETS_PASSPHRASE";

const secretsDirFlag = Flag.String("secrets-dir").pipe(
  Flag.withDescription("The store's secrets folder, for example <data-root>/userdata/secrets."),
);

const outFlag = Flag.String("out").pipe(
  Flag.withDescription("Where to write the passphrase-sealed bundle (JSON)."),
);

const inFlag = Flag.String("in").pipe(
  Flag.withDescription("The passphrase-sealed bundle to import."),
);

const forceFlag = Flag.Boolean("force").pipe(
  Flag.withDescription("Replace an existing bundle, or a different key already on this machine."),
  Flag.withDefault(false),
);

const passphraseEnvFlag = Flag.String("passphrase-env").pipe(
  Flag.withDescription(`Environment variable holding the passphrase (default ${PASSPHRASE_ENV}).`),
  Flag.withDefault(PASSPHRASE_ENV),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print one JSON summary line."),
  Flag.withDefault(false),
);

/**
 * The passphrase, from the named environment variable or one stdin line.
 * A missing or short passphrase fails before any file is read.
 */
export function readPassphrase(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
  readStdin: () => string = () => NodeFS.readFileSync(0, "utf8"),
): string {
  const fromEnv = env[envName];
  const value =
    fromEnv !== undefined && fromEnv !== "" ? fromEnv : (readStdin().split(/\r?\n/)[0] ?? "");
  const passphrase = value.trim();
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SecretsPortabilityError(
      "passphrase-too-short",
      `No passphrase: set ${envName} or pipe one long line (at least ${MIN_PASSPHRASE_LENGTH} characters) to stdin.`,
    );
  }
  return passphrase;
}

const reportFailure = (error: unknown): number => {
  const message =
    error instanceof SecretsPortabilityError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`secrets: ${message}\n`);
  return 1;
};

export interface SecretsExportCliOptions {
  readonly secretsDir: string;
  readonly out: string;
  readonly force: boolean;
  readonly passphraseEnv: string;
  readonly json: boolean;
}

/** The export the CLI and the migration script both run. */
export function runSecretsExport(
  options: SecretsExportCliOptions,
  deps: { readonly readPassphrase?: () => string } = {},
): number {
  try {
    const passphrase = (deps.readPassphrase ?? (() => readPassphrase(options.passphraseEnv)))();
    const result = exportSecretsBundle({
      secretsDir: options.secretsDir,
      outFile: options.out,
      passphrase,
      force: options.force,
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, entries: result.entries, source: result.source, out: result.outFile })}\n`,
      );
    } else {
      process.stdout.write(
        `Exported ${result.entries} saved secret(s), sealed with ${result.source}, to ${result.outFile}\n`,
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error);
  }
}

export interface SecretsImportCliOptions {
  readonly secretsDir: string;
  readonly in: string;
  readonly force: boolean;
  readonly passphraseEnv: string;
  readonly json: boolean;
}

/** The import the CLI and the migration script both run. */
export function runSecretsImport(
  options: SecretsImportCliOptions,
  deps: { readonly readPassphrase?: () => string } = {},
): number {
  try {
    const passphrase = (deps.readPassphrase ?? (() => readPassphrase(options.passphraseEnv)))();
    const result = importSecretsBundle({
      secretsDir: options.secretsDir,
      bundleFile: options.in,
      passphrase,
      force: options.force,
    });
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          entries: result.entries,
          imported: result.imported,
          unchanged: result.unchanged,
          dataKeyWritten: result.dataKeyWritten,
          keyBackup: result.keyBackup,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `Imported ${result.entries} saved secret(s): ${result.imported} written, ${result.unchanged} already present; ` +
          `${result.dataKeyWritten ? "data key re-sealed for this machine" : "data key already matched"}` +
          `${result.keyBackup === null ? "" : `; old key file kept at ${result.keyBackup}`}\n`,
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error);
  }
}

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const processIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

export interface SecretsStatusCliOptions {
  readonly secretsDir: string;
  readonly json: boolean;
}

export function runSecretsStatus(options: SecretsStatusCliOptions, io: CliIo = processIo): number {
  try {
    const result = inspectSealedStore(options.secretsDir);
    if (options.json) {
      io.out(`${JSON.stringify(result)}\n`);
    } else if (result.state === "locked") {
      io.out(
        `state: locked\nreason: ${result.reason}\nsource: ${result.source ?? "none"}\nsealed: ${result.sealed}\n`,
      );
    } else if (result.state === "open") {
      io.out(
        `state: open\nsource: ${result.source}\nsealed: ${result.sealed}\nunreadable: ${result.unreadable}\n`,
      );
    } else {
      io.out("state: absent\nsealed: 0\n");
    }
    return result.state === "locked" || (result.state === "open" && result.unreadable > 0) ? 1 : 0;
  } catch (error) {
    return reportFailure(error);
  }
}

export interface SecretsRewrapCliOptions {
  readonly secretsDir: string;
  readonly fromMaterialEnv: string;
  readonly check: boolean;
  readonly json: boolean;
}

export function runSecretsRewrap(
  options: SecretsRewrapCliOptions,
  deps: { readonly env?: NodeJS.ProcessEnv; readonly io?: CliIo } = {},
): number {
  const io = deps.io ?? processIo;
  const env = deps.env ?? process.env;
  try {
    const material = env[options.fromMaterialEnv];
    if (material === undefined || material.trim() === "") {
      throw new SecretsPortabilityError(
        "wrong-material",
        `No old machine material: set ${options.fromMaterialEnv} in the environment.`,
      );
    }
    const result = rewrapDataKey({
      secretsDir: options.secretsDir,
      oldMaterial: material,
      check: options.check,
    });
    if (options.json) {
      io.out(`${JSON.stringify({ ok: true, ...result })}\n`);
    } else if (result.status === "already-open") {
      io.out(
        `The secret key already opens on this machine (${result.entries} saved secret(s)). Nothing written.\n`,
      );
    } else if (result.status === "would-rewrap") {
      io.out(
        `Check passed: the old material opens all ${result.entries} saved secret(s). Nothing written.\n`,
      );
    } else {
      io.out(
        `Re-wrapped the secret key for this machine; ${result.entries} saved secret(s) open. Old key file kept at ${result.backup}\n`,
      );
    }
    return 0;
  } catch (error) {
    if (options.json && error instanceof SecretsPortabilityError) {
      io.out(`${JSON.stringify({ ok: false, code: error.code })}\n`);
    }
    io.err(
      `secrets: ${error instanceof SecretsPortabilityError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

const exitWith = (code: number) =>
  code === 0 ? Effect.void : Effect.sync(() => process.exit(code));

const statusCommand = Command.make(
  "status",
  { secretsDir: secretsDirFlag, json: jsonFlag },
  (flags) =>
    Effect.sync(() => runSecretsStatus({ secretsDir: flags.secretsDir, json: flags.json })).pipe(
      Effect.flatMap(exitWith),
    ),
).pipe(Command.withDescription("Say whether the saved-secret key opens on this machine."));

const fromMaterialEnvFlag = Flag.String("from-material-env").pipe(
  Flag.withDescription(
    "Environment variable holding the old machine's material (e.g. its machine-id).",
  ),
);

const checkFlag = Flag.Boolean("check").pipe(
  Flag.withDescription("Prove the old material opens every saved secret and write nothing."),
  Flag.withDefault(false),
);

const rewrapCommand = Command.make(
  "rewrap",
  {
    secretsDir: secretsDirFlag,
    fromMaterialEnv: fromMaterialEnvFlag,
    check: checkFlag,
    json: jsonFlag,
  },
  (flags) =>
    Effect.sync(() =>
      runSecretsRewrap({
        secretsDir: flags.secretsDir,
        fromMaterialEnv: flags.fromMaterialEnv,
        check: flags.check,
        json: flags.json,
      }),
    ).pipe(Effect.flatMap(exitWith)),
).pipe(
  Command.withDescription(
    "Re-seal the secret key for this machine using the old machine's material.",
  ),
);

const exportCommand = Command.make(
  "export",
  {
    secretsDir: secretsDirFlag,
    out: outFlag,
    force: forceFlag,
    passphraseEnv: passphraseEnvFlag,
    json: jsonFlag,
  },
  (flags) =>
    Effect.sync(() =>
      runSecretsExport({
        secretsDir: flags.secretsDir,
        out: flags.out,
        force: flags.force,
        passphraseEnv: flags.passphraseEnv,
        json: flags.json,
      }),
    ).pipe(
      Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.sync(() => process.exit(code)))),
    ),
).pipe(Command.withDescription("Write the saved secrets as one passphrase-sealed bundle."));

const importCommand = Command.make(
  "import",
  {
    secretsDir: secretsDirFlag,
    in: inFlag,
    force: forceFlag,
    passphraseEnv: passphraseEnvFlag,
    json: jsonFlag,
  },
  (flags) =>
    Effect.sync(() =>
      runSecretsImport({
        secretsDir: flags.secretsDir,
        in: flags.in,
        force: flags.force,
        passphraseEnv: flags.passphraseEnv,
        json: flags.json,
      }),
    ).pipe(
      Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.sync(() => process.exit(code)))),
    ),
).pipe(
  Command.withDescription(
    "Import a passphrase-sealed bundle, re-sealing the key for this machine.",
  ),
);

/** `t3 secrets <export|import>`; the migration scripts call it, the app never does. */
export const secretsCommand = Command.make("secrets").pipe(
  Command.withDescription("Move saved secrets between this machine and another (migration)."),
  Command.withSubcommands([exportCommand, importCommand, statusCommand, rewrapCommand]),
);
