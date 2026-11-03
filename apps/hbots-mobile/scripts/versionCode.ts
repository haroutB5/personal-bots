/**
 * One rule for a release name and its Android versionCode, shared by the app
 * config, the app's updater and the release scripts. Each part owns three
 * decimal digits, so any bump raises the code and two names can never collide.
 */
const VERSION_NAME = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

export interface ReleaseVersion {
  readonly name: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly code: number;
}

export function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = VERSION_NAME.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return {
    name: value,
    major,
    minor,
    patch,
    code: major * 1_000_000 + minor * 1_000 + patch,
  };
}

export function requireReleaseVersion(value: string, source: string): ReleaseVersion {
  const parsed = parseReleaseVersion(value);
  if (parsed === null) {
    throw new Error(`${source} must be x.y.z with each part 0-999, got ${value}`);
  }
  return parsed;
}
