// @effect-diagnostics nodeBuiltinImport:off - worker owns synchronous JSON parsing.
import { isSea } from "node:sea";
import { Worker } from "node:worker_threads";

import type { TranscriptParsePosition, TranscriptParseResult } from "./usageTranscriptReader.ts";

let worker: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** One reusable worker, one file at a time. No transcript bodies cross back. */
export function readDeepSeekOnWorker(
  filePath: string,
  resumeFrom?: TranscriptParsePosition,
  options?: { readonly streamingThresholdBytes?: number },
): Promise<TranscriptParseResult | null> {
  const run = queue.then(() => {
    // The executable has no sibling worker script. Its existing inline path
    // remains available, as it does when the worker switch is off.
    if (isSea()) throw new Error("Transcript worker needs a script runtime");
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    const active = (worker ??= new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../usage-transcript-worker.ts"
          : "./usage-transcript-worker.mjs",
        import.meta.url,
      ),
    ));
    // Keep an idle worker error from becoming an uncaught server error too.
    // The per-request listener below rejects the current read when busy.
    if (active.listenerCount("error") === 0)
      active.on("error", () => {
        if (worker === active) worker = undefined;
      });
    active.ref();
    return new Promise<TranscriptParseResult | null>((resolve, reject) => {
      const cleanup = () => {
        active.removeListener("message", onMessage);
        active.removeListener("error", onError);
        active.removeListener("exit", onExit);
      };
      const onError = (error: Error) => {
        cleanup();
        if (worker === active) worker = undefined;
        void active.terminate();
        reject(error);
      };
      const onExit = (code: number) => onError(new Error(`Transcript worker exited (${code})`));
      const onMessage = (result: TranscriptParseResult | null) => {
        cleanup();
        active.unref();
        // Release memory after a provider refresh/usage scan has finished.
        idleTimer = setTimeout(() => {
          if (worker === active) worker = undefined;
          void active.terminate();
        }, 10_000);
        idleTimer.unref();
        resolve(result);
      };
      active.once("message", onMessage);
      active.once("error", onError);
      active.once("exit", onExit);
      try {
        active.postMessage({ filePath, resumeFrom, options });
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  queue = run.catch(() => undefined);
  return run;
}
