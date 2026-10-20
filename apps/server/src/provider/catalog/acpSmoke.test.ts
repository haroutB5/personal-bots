// @effect-diagnostics nodeBuiltinImport:off - the tests start real processes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runAcpInitializeSmoke } from "./acpSmoke.ts";
import { isCatalogInstallError } from "./errors.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(here, "../../../scripts/acp-mock-agent.ts");

/** Real processes need the real clock and the Node services. */
const live = <A, E>(effect: Effect.Effect<A, E, never>) => effect;

const smokeFailure = (spawn: Parameters<typeof runAcpInitializeSmoke>[0]) =>
  runAcpInitializeSmoke(spawn).pipe(
    Effect.provide(NodeServices.layer),
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("expected the launch check to fail");
      const reason = exit.cause.reasons.find((candidate) => candidate._tag === "Fail");
      return (reason as { error: unknown } | undefined)?.error;
    }),
  );

describe("ACP initialize launch check", () => {
  it.live("answers for an ACP agent that starts, and reads its sign-in methods", () =>
    live(
      runAcpInitializeSmoke({
        command: "node",
        args: [mockAgentPath],
        cwd: here,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        extendEnv: false,
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.map((result) => {
          expect(result.protocolVersion).toBe(1);
          expect(Array.isArray(result.authMethods)).toBe(true);
        }),
      ),
    ),
  );

  it.live("reports the agent's own last words when it stops before answering", () =>
    smokeFailure({
      command: "node",
      args: ["-e", "console.error('unsupported platform: win32-x64'); process.exit(3)"],
      cwd: here,
      extendEnv: true,
    }).pipe(
      Effect.map((error) => {
        expect(isCatalogInstallError(error)).toBe(true);
        expect(error).toMatchObject({ kind: "wontStart" });
        expect((error as { detail: string }).detail).toContain("unsupported platform: win32-x64");
      }),
    ),
  );

  it.live("reports a program that is not there", () =>
    smokeFailure({
      command: NodePath.join(here, "no-such-agent-program.exe"),
      args: [],
      cwd: here,
      extendEnv: true,
    }).pipe(
      Effect.map((error) => {
        expect(isCatalogInstallError(error)).toBe(true);
        expect(error).toMatchObject({ kind: "wontStart" });
        const detail = (error as { detail: string }).detail;
        expect(detail.length).toBeGreaterThan(0);
        expect(detail.length).toBeLessThanOrEqual(160);
      }),
    ),
  );

  it.live("does not take a program that answers with something other than ACP", () =>
    smokeFailure({
      command: "node",
      args: ["-e", "console.log('hello, I am not ACP'); process.exit(0)"],
      cwd: here,
      extendEnv: true,
    }).pipe(
      Effect.map((error) => {
        expect(isCatalogInstallError(error)).toBe(true);
        expect(error).toMatchObject({ kind: "wontStart" });
      }),
    ),
  );
});
