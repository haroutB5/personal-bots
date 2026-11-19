import { nativeLauncher } from "../launcher/nativeLauncher";

/**
 * When this process started, on the clock of `performance.now()`, or undefined when the native
 * module is missing (tests, an older APK) or throws. Read where a report is made, never at
 * import: the value does not change in a process.
 */
export function processStartAt(): number | undefined {
  try {
    return nativeLauncher?.processStartUptimeMs?.();
  } catch {
    return undefined;
  }
}

let firstOpenTaken = false;

/** The process start for the first chat open of this process, then undefined. */
export function takeFirstOpenProcessStart(): number | undefined {
  if (firstOpenTaken) return undefined;
  firstOpenTaken = true;
  return processStartAt();
}
