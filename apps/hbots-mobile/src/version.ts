/** Each release part owns three decimal digits, the same rule as app.config.ts. */
export function versionCodeOf(version: string): number | null {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3) {
    return null;
  }
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 999)) {
    return null;
  }
  const [major = 0, minor = 0, patch = 0] = parts;
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function isTooOld(installedVersion: string, requiredVersion: string): boolean {
  const installed = versionCodeOf(installedVersion);
  const required = versionCodeOf(requiredVersion);
  if (installed === null || required === null) {
    return false;
  }
  return installed < required;
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  const candidateCode = versionCodeOf(candidate);
  const installedCode = versionCodeOf(installed);
  if (candidateCode === null || installedCode === null) {
    return false;
  }
  return candidateCode > installedCode;
}
