// @effect-diagnostics nodeBuiltinImport:off - the CLI reads one stdin line with plain fs.
/**
 * `t3 secrets export|import`: move the saved secrets from the Windows install
 * to the Linux one without any plaintext on disk (see
 * `personal/secrets/secretsPortability.ts` for the format and the guarantees).
 *
 *   t3 secrets export --secrets-dir <…/userdata/secrets> --out <bundle>
 *   t3 secrets import --secrets-dir <…/userdata/secrets> --in <bundle>
 *
 * The passphrase comes from `HBOTS_SECRETS_PASSPHRASE` (or `--passphrase-env`)
 * and never from an argument, so it cannot land in a shell history or a
 * process listing. Without it the command reads one line from stdin.
 *
 * Nothing here prints a secret value or the passphrase; counts and paths only.
 */
import * as NodeFS from "node:fs";

import { Command, Flag } from "effect/unstable/cli";
import * as Effect from "effect/Effect";

import {
  MIN_PASSPHRASE_LENGTH,
  SecretsPortabilityError,
  exportSecretsBundle,
  importSecretsBundle,
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
  const value = fromEnv !== undefined && fromEnv !== "" ? fromEnv : readStdin().split(/\r?\n/)[0] ?? "";
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
        })}\n`,
      );
    } else {
      process.stdout.write(
        `Imported ${result.entries} saved secret(s): ${result.imported} written, ${result.unchanged} already present; ` +
          `${result.dataKeyWritten ? "data key re-sealed for this machine" : "data key already matched"}\n`,
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error);
  }
}

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
      Effect.flatMap((code) =>
        code === 0 ? Effect.void : Effect.sync(() => process.exit(code)),
      ),
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
      Effect.flatMap((code) =>
        code === 0 ? Effect.void : Effect.sync(() => process.exit(code)),
      ),
    ),
).pipe(Command.withDescription("Import a passphrase-sealed bundle, re-sealing the key for this machine."));

/** `t3 secrets <export|import>`; the migration scripts call it, the app never does. */
export const secretsCommand = Command.make("secrets").pipe(
  Command.withDescription("Move saved secrets between this machine and another (migration)."),
  Command.withSubcommands([exportCommand, importCommand]),
);
