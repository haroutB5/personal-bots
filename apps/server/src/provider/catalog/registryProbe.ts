/**
 * The two checks on an installed registry agent that start it: the health probe
 * (ACP `initialize` plus `session/new`, no prompt, no model call) and the
 * one-message test. Both run in background fibers or on an explicit button,
 * never while a request waits for them.
 *
 * @module provider/catalog/registryProbe
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "../acp/AcpStderr.ts";
import { terminateDescendants } from "../processTree.ts";
import { firstSafeLine } from "./errors.ts";
import type { CatalogInstaller } from "./installer.ts";
import { toSpawnInput } from "./launch.ts";
import {
  isAuthRequiredError,
  REGISTRY_FIRST_OUTPUT_TIMEOUT_MS,
  toAuthMethods,
  type RegistryAuthMethod,
} from "./registryAuth.ts";
import {
  buildRegistryModels,
  registryCurrentModel,
  registryModelSwitch,
} from "./registryModels.ts";

const PROBE_TIMEOUT = "60 seconds";
const CLIENT_INFO = { name: "hbots", version: "1.66.77" } as const;

/** The turn stayed completely silent past the first-output deadline. */
export class RegistryTurnSilent extends Schema.TaggedError<RegistryTurnSilent>()(
  "RegistryTurnSilent",
  {},
) {}

/**
 * Runs a prompt, but fails with `RegistryTurnSilent` when nothing at all
 * (no text, thought, tool call or plan) arrived within the deadline. Once
 * anything arrived the turn is left to run as long as the agent needs.
 */
export const promptUnlessSilent = <A, E, R>(input: {
  readonly prompt: Effect.Effect<A, E, R>;
  readonly sawOutput: Effect.Effect<boolean>;
  readonly timeout?: Duration.Input;
}): Effect.Effect<A, E | RegistryTurnSilent, R> =>
  // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - the deadline only applies while nothing was heard
  Effect.raceFirst(
    input.prompt,
    Effect.sleep(input.timeout ?? Duration.millis(REGISTRY_FIRST_OUTPUT_TIMEOUT_MS)).pipe(
      Effect.andThen(
        Effect.flatMap(input.sawOutput, (heard) =>
          heard ? Effect.never : Effect.fail(new RegistryTurnSilent()),
        ),
      ),
    ),
  );

export const isRegistryTurnSilent = Schema.is(RegistryTurnSilent);

/** The agent cannot be launched on this computer (for example, Node.js is missing). */
export class RegistryLaunchError extends Schema.TaggedError<RegistryLaunchError>()(
  "RegistryLaunchError",
  { message: Schema.String },
) {}

export type RegistryProbeResult =
  | { readonly kind: "notInstalled" }
  | {
      readonly kind: "ok";
      readonly agentVersion: string | null;
      readonly authMethods: ReadonlyArray<RegistryAuthMethod>;
      readonly models: ReadonlyArray<ServerProviderModel>;
    }
  | { readonly kind: "authRequired"; readonly authMethods: ReadonlyArray<RegistryAuthMethod> }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly authMethods: ReadonlyArray<RegistryAuthMethod>;
    };

export interface RegistryLaunchOptions {
  readonly installer: CatalogInstaller["Service"];
  readonly catalogId: string;
  readonly nodePath: string | null;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Starts the agent in a scratch folder under a lease, so Remove waits for it.
 * Everything it opens closes with the scope, the process tree first.
 */
const openRuntime = (options: RegistryLaunchOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installed = yield* options.installer.acquire(options.catalogId);
    const spawn = toSpawnInput(
      installed,
      {
        nodePath: options.nodePath,
        hostEnvironment: options.hostEnvironment,
        ...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
      },
      path.join,
    );
    if (spawn === null) {
      return yield* new RegistryLaunchError({
        message: "This agent needs Node.js, which was not found on this computer.",
      });
    }
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-registry-probe-" });
    const state = { stderrTail: "", pid: undefined as number | undefined };
    let authMethods: ReadonlyArray<RegistryAuthMethod> = [];
    const runtime = yield* AcpSessionRuntime.make({
      spawn,
      cwd,
      authMethodId: null,
      clientInfo: CLIENT_INFO,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      onProcessStarted: (pid) =>
        Effect.sync(() => {
          state.pid = pid;
        }),
      onStderr: (text) =>
        Effect.sync(() => {
          state.stderrTail = appendAcpStderrTail(state.stderrTail, text);
        }),
      // Failed sessions do not return the initialize result; keep the sign-in options.
      requestLogger: (event) =>
        Effect.sync(() => {
          if (event.method === "initialize" && event.status === "succeeded") {
            const result = event.result as EffectAcpSchema.InitializeResponse | undefined;
            authMethods = toAuthMethods(result?.authMethods ?? []);
          }
        }),
    });
    // Added after the runtime, so it runs first on close: a launcher that
    // started a child leaves it running on Windows unless the child goes first.
    yield* Effect.addFinalizer(() =>
      state.pid === undefined ? Effect.void : terminateDescendants(state.pid).pipe(Effect.asVoid),
    );
    return {
      runtime,
      installed,
      authMethods: () => authMethods,
      stderrLine: () => firstSafeLine(sanitizeAcpStderrExcerpt(state.stderrTail)),
    };
  });

/** Initialize plus a new session. Never prompts, so it costs no tokens and cannot sign anyone in. */
export const probeRegistryAgent = (
  options: RegistryLaunchOptions,
): Effect.Effect<
  RegistryProbeResult,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const opened = yield* Effect.result(openRuntime(options));
    if (opened._tag === "Failure") {
      const failure = opened.failure as { readonly _tag?: string; readonly message: string };
      // Acquire fails with the installer's error when nothing complete is on disk.
      return failure._tag === "CatalogInstallError"
        ? ({ kind: "notInstalled" } satisfies RegistryProbeResult)
        : ({
            kind: "failed",
            message: failure.message,
            authMethods: [],
          } satisfies RegistryProbeResult);
    }
    const { runtime, authMethods, stderrLine } = opened.success;
    const started = yield* Effect.result(runtime.start());
    if (started._tag === "Success") {
      return {
        kind: "ok",
        agentVersion: started.success.initializeResult.agentInfo?.version ?? null,
        authMethods: toAuthMethods(started.success.initializeResult.authMethods ?? []),
        models: buildRegistryModels(started.success.sessionSetupResult),
      } satisfies RegistryProbeResult;
    }
    if (isAuthRequiredError(started.failure)) {
      return { kind: "authRequired", authMethods: authMethods() } satisfies RegistryProbeResult;
    }
    // The agent's own last words are the useful part ("unsupported platform").
    const fallback = firstSafeLine(
      sanitizeAcpStderrExcerpt((started.failure as { message?: string }).message ?? ""),
    );
    return {
      kind: "failed",
      message: stderrLine() || fallback || "It stopped before it answered.",
      authMethods: authMethods(),
    } satisfies RegistryProbeResult;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.succeed({
          kind: "failed",
          message: "It did not answer within a minute.",
          authMethods: [],
        } satisfies RegistryProbeResult),
    }),
  );

export type RegistrySmokeOutcome =
  | { readonly kind: "passed"; readonly authMethods: ReadonlyArray<RegistryAuthMethod> }
  | { readonly kind: "silent"; readonly authMethods: ReadonlyArray<RegistryAuthMethod> }
  | { readonly kind: "failed"; readonly message: string };

/**
 * One real message: starts a session, selects `model`, sends a short prompt and
 * waits for the answer. A turn that stays silent past the deadline is reported
 * as `silent`, which for an agent with sign-in options means "needs you to sign in".
 */
export const smokeTestRegistryAgent = (
  options: RegistryLaunchOptions & {
    readonly model: string;
    readonly firstOutputTimeout?: Duration.Input;
  },
): Effect.Effect<
  RegistrySmokeOutcome,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const opened = yield* Effect.result(openRuntime(options));
    if (opened._tag === "Failure") {
      return {
        kind: "failed",
        message: (opened.failure as { message: string }).message,
      } satisfies RegistrySmokeOutcome;
    }
    const { runtime, authMethods, stderrLine } = opened.success;
    let heard = false;
    yield* Stream.runForEach(runtime.getEvents(), (event) => {
      if (event._tag === "EventStreamBarrier") {
        return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
      }
      if (
        event._tag === "ContentDelta" ||
        event._tag === "ThoughtDelta" ||
        event._tag === "ToolCallUpdated" ||
        event._tag === "PlanUpdated" ||
        event._tag === "AssistantItemStarted"
      ) {
        heard = true;
      }
      return Effect.void;
    }).pipe(Effect.forkScoped);
    const run = Effect.gen(function* () {
      const started = yield* runtime.start();
      const setup = started.sessionSetupResult;
      if (registryCurrentModel(setup) !== options.model) {
        const switchVia = registryModelSwitch(setup);
        if (switchVia === "config") yield* runtime.setModel(options.model);
        else if (switchVia === "session") yield* runtime.setSessionModel(options.model);
      }
      yield* promptUnlessSilent({
        prompt: runtime.prompt({
          prompt: [{ type: "text", text: "Reply with the single word: ok" }],
        }),
        sawOutput: Effect.sync(() => heard),
        ...(options.firstOutputTimeout !== undefined
          ? { timeout: options.firstOutputTimeout }
          : {}),
      }).pipe(Effect.onError(() => runtime.cancel.pipe(Effect.ignore)));
    });
    const result = yield* Effect.result(run);
    if (result._tag === "Success") {
      return { kind: "passed", authMethods: authMethods() } satisfies RegistrySmokeOutcome;
    }
    if (isRegistryTurnSilent(result.failure)) {
      return { kind: "silent", authMethods: authMethods() } satisfies RegistrySmokeOutcome;
    }
    if (isAuthRequiredError(result.failure)) {
      return { kind: "silent", authMethods: authMethods() } satisfies RegistrySmokeOutcome;
    }
    const fallback = firstSafeLine(
      sanitizeAcpStderrExcerpt((result.failure as { message?: string }).message ?? ""),
    );
    return {
      kind: "failed",
      message: stderrLine() || fallback || "It stopped before it answered.",
    } satisfies RegistrySmokeOutcome;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () =>
        Effect.succeed({
          kind: "failed",
          message: "It did not finish within five minutes.",
        } satisfies RegistrySmokeOutcome),
    }),
  );
