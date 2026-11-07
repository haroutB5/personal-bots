/**
 * The one place a host read asks whether a path holds credentials or machine
 * state. The requested spelling and the resolved real path are both checked, so
 * a symlink cannot smuggle a secret out under a harmless name.
 */
import { isProtectedHostPath } from "../../workspace/HostFilePaths.ts";

export interface HostReadTarget {
  /** The path as the caller wrote it, before resolution. */
  readonly requestedPath: string;
  /** The real path the read would open. */
  readonly resolvedPath: string;
}

/** The path that must not be read, or null when the read may proceed. */
export function protectedHostReadPath(target: HostReadTarget): string | null {
  if (isProtectedHostPath(target.requestedPath)) return target.requestedPath;
  if (isProtectedHostPath(target.resolvedPath)) return target.resolvedPath;
  return null;
}
