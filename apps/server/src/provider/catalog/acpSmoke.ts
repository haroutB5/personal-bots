/**
 * The "does it start" check for an installed registry agent: launch it and
 * send ACP `initialize`, nothing else. No sign-in, no session, no model call.
 * A program that answers with a protocol version is an ACP agent that starts
 * on this machine.
 *
 * @module provider/catalog/acpSmoke
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "../acp/AcpStderr.ts";
import { terminateDescendants } from "../processTree.ts";
import {
  CatalogInstallError,
  firstSafeLine,
  installError,
  isCatalogInstallError,
} from "./errors.ts";

const SMOKE_TIMEOUT = "120 seconds";

export interface AcpSmokeResult {
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly protocolVersion: number;
  readonly authMethods: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export type AcpSmoke = (
  spawn: AcpSessionRuntime.AcpSpawnInput,
) => Effect.Effect<
  AcpSmokeResult,
  CatalogInstallError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
>;

/** Launches the agent, sends `initialize`, and ends the process tree. */
export const runAcpInitializeSmoke: AcpSmoke = (spawn) =>
  Effect.suspend(() => {
    let stderrTail = "";
    let launcherPid: number | undefined;
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn,
          cwd: spawn.cwd ?? process.cwd(),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          authMethodId: "",
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          onProcessStarted: (pid) =>
            Effect.sync(() => {
              launcherPid = pid;
            }),
          onStderr: (text) =>
            Effect.sync(() => {
              stderrTail = appendAcpStderrTail(stderrTail, text);
            }),
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
      );
      // Added after the runtime, so it runs before the runtime stops: a launcher
      // that started a child leaves it running on Windows unless the child goes first.
      yield* Effect.addFinalizer(() =>
        launcherPid === undefined
          ? Effect.void
          : terminateDescendants(launcherPid).pipe(Effect.asVoid),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const response = yield* runtime.initialize();
      if (!Number.isInteger(response.protocolVersion) || response.protocolVersion < 1) {
        return yield* installError("wontStart", "It started but did not answer as an ACP agent.");
      }
      return {
        agentName: response.agentInfo?.name ?? null,
        agentVersion: response.agentInfo?.version ?? null,
        protocolVersion: response.protocolVersion,
        authMethods: (response.authMethods ?? []).map((method) => ({
          id: method.id,
          name: method.name,
        })),
      } satisfies AcpSmokeResult;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: SMOKE_TIMEOUT,
        orElse: () =>
          Effect.fail(installError("wontStart", "It did not answer within two minutes.")),
      }),
      // The agent's own last words are the useful part ("unsupported platform");
      // fall back to the protocol error when it said nothing.
      Effect.mapError((error: unknown) => {
        if (isCatalogInstallError(error)) return error;
        const spoken = firstSafeLine(sanitizeAcpStderrExcerpt(stderrTail));
        const fallback = firstSafeLine(
          sanitizeAcpStderrExcerpt((error as { message?: string } | null)?.message ?? ""),
        );
        return installError("wontStart", spoken || fallback || "It stopped before it answered.", {
          cause: error,
        });
      }),
    );
  });
