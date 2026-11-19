import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const MAIN_NAMES: ReadonlySet<string> = new Set(["thunderbird", "thunderbird-bin"]);

/**
 * The main Thunderbird processes, read from a /proc-shaped folder. A process
 * counts when the program it was started as is Thunderbird itself, which
 * leaves out a shell or editor that merely has the word in an argument, and
 * its content children (`-contentproc`).
 */
export const findThunderbirdPids = (procRoot: string): ReadonlyArray<number> => {
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(procRoot);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      const argv = NodeFS.readFileSync(NodePath.join(procRoot, entry, "cmdline"), "utf8").split(
        "\0",
      );
      const program = NodePath.basename(argv[0] ?? "");
      return MAIN_NAMES.has(program) && !argv.includes("-contentproc") ? [Number(entry)] : [];
    } catch {
      return [];
    }
  });
};

export class ThunderbirdProcess extends Context.Service<
  ThunderbirdProcess,
  { readonly running: () => Effect.Effect<boolean> }
>()("t3/personal/connections/email/thunderbird/ThunderbirdProcess") {}

export const layerLive = Layer.succeed(ThunderbirdProcess, {
  running: () => Effect.sync(() => findThunderbirdPids("/proc").length > 0),
});

export const layerOf = (running: boolean) =>
  Layer.succeed(ThunderbirdProcess, { running: () => Effect.succeed(running) });
