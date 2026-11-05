/**
 * The installed Claude Code version, read by spawning `claude --version`.
 *
 * The nightly update review needs this one fact, so it spawns the binary
 * itself instead of reaching into the provider layer. Any failure reads as
 * "unknown": a missing binary, a non-zero exit or output with no version.
 *
 * @module personal/claudeCodeReview/claudeCliVersion
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { expandHomePath } from "../../pathExpansion.ts";

/** "claude 2.1.100" or "v2.1.100" becomes "2.1.100". */
export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

export const claudeCliVersion = (
  settings: Pick<ClaudeSettings, "binaryPath" | "homePath">,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const homePath = settings.homePath.trim();
    const env: NodeJS.ProcessEnv =
      homePath.length === 0
        ? process.env
        : { ...process.env, CLAUDE_CONFIG_DIR: path.resolve(expandHomePath(homePath)) };
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], { env });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        shell: spawnCommand.shell,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectText(child.stdout),
        collectText(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return exitCode === 0 ? parseGenericCliVersion(`${stdout}\n${stderr}`) : null;
  }).pipe(
    Effect.scoped,
    Effect.catchCause(() => Effect.succeed(null)),
  );
