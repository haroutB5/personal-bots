// @effect-diagnostics nodeBuiltinImport:off
/**
 * One-message provider smoke tests for personal bots.
 *
 * After a provider's installed version changes, the personal layer runs one
 * minimal turn through the same executable and the same isolation a bot
 * session gets (no settings files, no MCP, no owner add-ons), so a broken
 * update is noticed before the next real bot turn trips over it.
 *
 * @module provider/providerSmokeTest
 */
import * as NodeOS from "node:os";

import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../pathExpansion.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { ProviderDriverError } from "./Errors.ts";
import {
  PERSONAL_BOT_CLAUDE_ENVIRONMENT,
  PERSONAL_BOT_CLAUDE_SETTINGS,
} from "./Layers/ClaudeAdapter.ts";
import {
  codexExecLaunchArgs,
  listOwnerCodexSkillFiles,
  PERSONAL_BOT_CODEX_APP_SERVER_ARGS,
  personalBotCodexSkillArgs,
} from "./Layers/codexLaunchArgs.ts";
import { personalBotOpenCodeEnvironment } from "./opencodeBotIsolation.ts";

export const SMOKE_TEST_PROMPT = "Reply with exactly one word: ready. Do not use any tools.";
const SMOKE_TEST_TIMEOUT = Duration.minutes(3);
const SMOKE_TEST_TIMEOUT_LABEL = "3 minutes";
const OUTPUT_MAX_BYTES = 4_000;

/**
 * The end of a process's output, cut at a line or at least a word: a cut
 * mid-word read "rect API key provided" in the Codex alert (25 Sep).
 */
export function lastLines(text: string, maxLength = 400): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const tail = trimmed.slice(-maxLength);
  const lineStart = tail.indexOf("\n");
  if (lineStart >= 0) return `…${tail.slice(lineStart + 1)}`;
  const wordStart = tail.search(/\s/);
  return wordStart >= 0 ? `…${tail.slice(wordStart + 1)}` : `…${tail}`;
}

/** SDK options for the Claude smoke turn: a personal-bot session's isolation, no tools, one turn. */
export function buildClaudeSmokeTestQueryOptions(input: {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly model: string;
  readonly abortController: AbortController;
  readonly onStderr?: (data: string) => void;
}): ClaudeQueryOptions {
  return {
    cwd: input.cwd,
    model: input.model,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    persistSession: false,
    maxTurns: 1,
    allowedTools: [],
    settingSources: [],
    settings: { ...PERSONAL_BOT_CLAUDE_SETTINGS },
    mcpServers: {},
    strictMcpConfig: true,
    env: { ...input.environment, ...PERSONAL_BOT_CLAUDE_ENVIRONMENT },
    stderr: input.onStderr ?? (() => {}),
  };
}

const isResultMessage = (message: SDKMessage): message is SDKResultMessage =>
  message.type === "result";

/** Null when the turn produced a non-empty reply; otherwise the provider's own failure text. */
export function claudeSmokeTestFailure(messages: ReadonlyArray<SDKMessage>): string | null {
  const result = messages.findLast(isResultMessage);
  if (result === undefined) return "Claude Code ended without replying.";
  if (result.subtype === "success") {
    const reply = result.result.trim();
    if (result.is_error) return reply.length > 0 ? reply : "Claude Code reported an error.";
    return reply.length > 0 ? null : "Claude Code replied with an empty message.";
  }
  const errors = result.errors.join("\n").trim();
  return errors.length > 0 ? errors : `Claude Code failed (${result.subtype}).`;
}

export type ClaudeSmokeTestQuery = (input: {
  readonly prompt: string;
  readonly options: ClaudeQueryOptions;
}) => AsyncIterable<SDKMessage>;

export const runClaudeSmokeTest = (input: {
  readonly instanceId: string;
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly model: string;
  readonly createQuery?: ClaudeSmokeTestQuery;
}): Effect.Effect<void, ProviderDriverError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fail = (detail: string, cause?: unknown) =>
      new ProviderDriverError({
        driver: "claudeAgent",
        instanceId: input.instanceId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-smoke-claude-" })
      .pipe(Effect.mapError((cause) => fail("Could not create a scratch directory.", cause)));
    const abortController = new AbortController();
    let stderr = "";
    const options = buildClaudeSmokeTestQueryOptions({
      executablePath: input.executablePath,
      environment: input.environment,
      cwd,
      model: input.model,
      abortController,
      onStderr: (data) => {
        stderr = (stderr + data).slice(-OUTPUT_MAX_BYTES);
      },
    });
    const createQuery: ClaudeSmokeTestQuery =
      input.createQuery ??
      ((request) => query({ prompt: request.prompt, options: request.options }));

    const messages = yield* Effect.tryPromise({
      try: async (signal) => {
        signal.addEventListener("abort", () => abortController.abort(), { once: true });
        const collected: Array<SDKMessage> = [];
        for await (const message of createQuery({ prompt: SMOKE_TEST_PROMPT, options })) {
          collected.push(message);
        }
        return collected;
      },
      catch: (cause) => {
        const detail = cause instanceof Error ? cause.message : "Claude Code could not start.";
        const tail = lastLines(stderr);
        return fail(tail.length > 0 ? `${detail}\n${tail}` : detail, cause);
      },
    }).pipe(Effect.timeoutOption(SMOKE_TEST_TIMEOUT));
    if (Option.isNone(messages)) {
      abortController.abort();
      return yield* fail(`Claude Code did not reply within ${SMOKE_TEST_TIMEOUT_LABEL}.`);
    }
    const failure = claudeSmokeTestFailure(messages.value);
    if (failure !== null) return yield* fail(failure);
  }).pipe(Effect.scoped, Effect.withSpan("runClaudeSmokeTest"));

/**
 * The owner's own Codex skill roots, resolved the way the Codex adapter
 * resolves them for a personal-bot session.
 */
export function ownerCodexSkillRoots(
  homePath: string,
  environment: NodeJS.ProcessEnv,
  join: (...segments: ReadonlyArray<string>) => string,
): ReadonlyArray<string> {
  const configuredHome = homePath || environment.CODEX_HOME || "~/.codex";
  const codexHome =
    configuredHome === "~" || /^~[\\/]/.test(configuredHome)
      ? join(NodeOS.homedir(), configuredHome.slice(2))
      : configuredHome;
  return [join(codexHome, "skills"), join(NodeOS.homedir(), ".agents", "skills")];
}

/** `codex exec` argv for the smoke turn: a personal bot's config overrides, read-only, ephemeral. */
export function buildCodexSmokeTestArgs(input: {
  readonly launchArgs: string | undefined;
  readonly model: string;
  readonly skillFiles: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return [
    "exec",
    ...codexExecLaunchArgs(input.launchArgs),
    ...PERSONAL_BOT_CODEX_APP_SERVER_ARGS,
    ...personalBotCodexSkillArgs(input.skillFiles),
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--model",
    input.model,
    "-",
  ];
}

export const runCodexSmokeTest = (input: {
  readonly instanceId: string;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly launchArgs: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly model: string;
}): Effect.Effect<
  void,
  ProviderDriverError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fail = (detail: string, cause?: unknown) =>
      new ProviderDriverError({
        driver: "codex",
        instanceId: input.instanceId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-smoke-codex-" })
      .pipe(Effect.mapError((cause) => fail("Could not create a scratch directory.", cause)));
    const skillFiles = yield* listOwnerCodexSkillFiles(
      ownerCodexSkillRoots(input.homePath, input.environment, (...segments) =>
        path.join(...segments),
      ),
    );
    const spawnCommand = yield* resolveSpawnCommand(
      input.binaryPath || "codex",
      buildCodexSmokeTestArgs({
        launchArgs: input.launchArgs,
        model: input.model,
        skillFiles,
      }),
      { env: input.environment },
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: {
            ...input.environment,
            ...(input.homePath ? { CODEX_HOME: expandHomePath(input.homePath) } : {}),
          },
          cwd,
          shell: spawnCommand.shell,
          stdin: { stream: Stream.encodeText(Stream.make(SMOKE_TEST_PROMPT)) },
        }),
      )
      .pipe(Effect.mapError((cause) => fail(`Codex could not start: ${cause.message}`, cause)));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: OUTPUT_MAX_BYTES }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: OUTPUT_MAX_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError((cause) => fail("Codex output could not be read.", cause)));
    if (Number(exitCode) !== 0) {
      const tail = lastLines(stderr.text) || lastLines(stdout.text);
      return yield* fail(tail.length > 0 ? tail : `Codex exited with code ${Number(exitCode)}.`);
    }
    if (stdout.text.trim().length === 0) return yield* fail("Codex replied with an empty message.");
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(SMOKE_TEST_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onSome: () => Effect.void,
        onNone: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: "codex",
              instanceId: input.instanceId,
              detail: `Codex did not reply within ${SMOKE_TEST_TIMEOUT_LABEL}.`,
            }),
          ),
      }),
    ),
    Effect.withSpan("runCodexSmokeTest"),
  );

/** `opencode run` argv for the smoke turn; the bot isolation and a deny-all tool rule ride in the env. */
/**
 * The environment one OpenCode smoke turn runs in.
 *
 * Notably it does NOT deny tools. It used to: a check has no business calling
 * anything, and the prompt only asks for a word. But OpenCode's free tier
 * answers a deny-everything session with a 403 "can only be used from within
 * OpenCode", so the probe failed while every real bot turn — which allows
 * tools — succeeded. The isolation home already keeps the owner's MCP servers,
 * plugins and skills out, and the turn runs in a scratch directory, so the
 * blast radius stays small without a setting that no real session uses.
 */
export function openCodeSmokeTestEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly configHome: string;
  readonly model: string;
}): NodeJS.ProcessEnv {
  return personalBotOpenCodeEnvironment({
    base: input.environment,
    configHome: input.configHome,
    model: input.model,
  });
}

export function buildOpenCodeSmokeTestArgs(input: {
  readonly model: string;
}): ReadonlyArray<string> {
  return ["run", "-m", input.model, "--format", "json", SMOKE_TEST_PROMPT];
}

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The text of a `{"type":"error","error":{"name","data":{"message"}}}` line. */
function openCodeErrorText(error: unknown): string {
  if (!isRecord(error)) return "OpenCode reported an error.";
  const data = isRecord(error.data) ? error.data : undefined;
  const message = typeof data?.message === "string" ? data.message.trim() : "";
  if (message.length > 0) return message;
  return typeof error.name === "string" && error.name.trim().length > 0
    ? error.name.trim()
    : "OpenCode reported an error.";
}

/**
 * Null when `opencode run --format json` produced a non-empty reply; otherwise
 * OpenCode's own error text (its NDJSON `error` event), the stderr tail, or
 * why the reply was unusable.
 */
export function openCodeSmokeTestFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}): string | null {
  let reply = "";
  let error: string | undefined;
  for (const line of input.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const event = Option.getOrUndefined(decodeJsonLine(trimmed));
    if (!isRecord(event)) continue;
    if (event.type === "error") error ??= openCodeErrorText(event.error);
    if (event.type === "text" && isRecord(event.part) && typeof event.part.text === "string") {
      reply += event.part.text;
    }
  }
  if (error !== undefined) return error;
  if (input.exitCode !== 0) {
    const tail = lastLines(input.stderr) || lastLines(input.stdout);
    return tail.length > 0 ? tail : `OpenCode exited with code ${input.exitCode}.`;
  }
  return reply.trim().length > 0 ? null : "OpenCode replied with an empty message.";
}

export const runOpenCodeSmokeTest = (input: {
  readonly instanceId: string;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  /** The bots' `XDG_CONFIG_HOME` (`ensurePersonalBotOpenCodeHome`). */
  readonly configHome: string;
  readonly model: string;
}): Effect.Effect<
  void,
  ProviderDriverError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fail = (detail: string, cause?: unknown) =>
      new ProviderDriverError({
        driver: "opencode",
        instanceId: input.instanceId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-smoke-opencode-" })
      .pipe(Effect.mapError((cause) => fail("Could not create a scratch directory.", cause)));
    const environment = openCodeSmokeTestEnvironment(input);
    const spawnCommand = yield* resolveSpawnCommand(
      input.binaryPath || "opencode",
      buildOpenCodeSmokeTestArgs({ model: input.model }),
      { env: environment },
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          cwd,
          shell: spawnCommand.shell,
          // `opencode run` appends piped stdin to the message; give it none.
          stdin: "ignore",
        }),
      )
      .pipe(Effect.mapError((cause) => fail(`OpenCode could not start: ${cause.message}`, cause)));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: OUTPUT_MAX_BYTES }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: OUTPUT_MAX_BYTES }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError((cause) => fail("OpenCode output could not be read.", cause)));
    const failure = openCodeSmokeTestFailure({
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: Number(exitCode),
    });
    if (failure !== null) return yield* fail(failure);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(SMOKE_TEST_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onSome: () => Effect.void,
        onNone: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: "opencode",
              instanceId: input.instanceId,
              detail: `OpenCode did not reply within ${SMOKE_TEST_TIMEOUT_LABEL}.`,
            }),
          ),
      }),
    ),
    Effect.withSpan("runOpenCodeSmokeTest"),
  );
