import { parseReleaseVersion } from "../scripts/versionCode.ts";

/** Each release part owns three decimal digits, the same rule as app.config.ts. */
export function versionCodeOf(version: string): number | null {
  return parseReleaseVersion(version)?.code ?? null;
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
