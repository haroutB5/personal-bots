import type { AndroidRelease } from "./compat";
import type { UpdateSnapshot } from "./updater";
import { isNewerVersion } from "./version";

export type UpdateAction = "none" | "check" | "install" | "permission";

export interface UpdateDescription {
  readonly title: string;
  readonly detail: string;
  readonly action: UpdateAction;
}

export function describeUpdate(
  snapshot: UpdateSnapshot | null,
  latest: AndroidRelease | null,
): UpdateDescription {
  if (snapshot === null) {
    return {
      title: "App updates",
      detail: "Update status is not available on this build.",
      action: "none",
    };
  }
  const target = snapshot.target;
  switch (snapshot.state) {
    case "downloading":
      return {
        title: `Downloading hbots ${target?.version ?? ""}`.trim(),
        detail: "It installs after 10 minutes in the background, never while you use the app.",
        action: "none",
      };
    case "ready":
      return {
        title: `hbots ${target?.version ?? ""} is ready`.trim(),
        detail: "It installs after 10 minutes in the background. You can install it now instead.",
        action: "install",
      };
    case "installing":
      return {
        title: `Installing hbots ${target?.version ?? ""}`.trim(),
        detail: "hbots restarts when the install finishes.",
        action: "none",
      };
    case "needsTap":
      return {
        title: `hbots ${target?.version ?? ""} needs one tap`.trim(),
        detail: "Open the Update ready notification to finish the install.",
        action: "install",
      };
    case "needsPermission":
      return {
        title: "Allow app installs",
        detail: "Android needs your permission before hbots can update itself.",
        action: "permission",
      };
    case "idle":
      if (latest !== null && isNewerVersion(latest.version, snapshot.installedVersion)) {
        if (snapshot.rejected === latest.version) {
          return {
            title: "Update blocked",
            detail: "hbots rejected the last download. Check now to fetch it again.",
            action: "check",
          };
        }
        return {
          title: `hbots ${latest.version} is available`,
          detail: "The download starts with the next check.",
          action: "check",
        };
      }
      return {
        title: "Up to date",
        detail: `hbots ${snapshot.installedVersion} is the latest version.`,
        action: "none",
      };
    default:
      return {
        title: "App updates",
        detail: "Update status is not available on this build.",
        action: "none",
      };
  }
}

export function describeSignedOutUpdate(
  latest: AndroidRelease | null,
  installedVersion: string,
  rejectedVersion: string | null,
): string | null {
  if (latest === null || !isNewerVersion(latest.version, installedVersion)) {
    return null;
  }
  if (rejectedVersion === latest.version) {
    return null;
  }
  return `hbots ${latest.version} is waiting. Pair this phone to install it.`;
}

export function describeLastCheck(lastCheckAt: number | null, now: number): string {
  if (lastCheckAt === null) {
    return "Not checked yet";
  }
  const minutes = Math.floor(Math.max(0, now - lastCheckAt) / 60_000);
  if (minutes < 1) {
    return "Checked just now";
  }
  if (minutes < 60) {
    return `Checked ${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Checked ${hours} h ago`;
  }
  return `Checked ${Math.floor(hours / 24)} d ago`;
}
