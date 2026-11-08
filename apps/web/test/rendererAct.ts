// react-test-renderer re-exports React.act; this import carries its generic type.
import { act as rendererAct } from "react";

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === "function";

// react-test-renderer's act with React's act flag on only while it runs, the
// contract test/render.tsx keeps for browser tests. A sync callback flushes
// inside act, so the flag drops as soon as act returns.
export function act<T>(callback: () => T | Promise<T>): Promise<Awaited<T>> {
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const restore = () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  };
  let async = false;
  try {
    const pending = rendererAct(() => {
      const result = callback();
      async = isThenable(result);
      return result;
    });
    if (!async) {
      restore();
      return Promise.resolve(pending);
    }
    return Promise.resolve(pending).finally(restore);
  } catch (error) {
    restore();
    throw error;
  }
}
