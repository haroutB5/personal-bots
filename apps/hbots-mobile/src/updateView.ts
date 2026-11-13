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
        detail: "hbots tells you when it is ready. It never restarts by itself.",
        action: "none",
      };
    case "ready":
      return {
        title: `hbots ${target?.version ?? ""} is ready`.trim(),
        detail: "Tap Restart to update. It takes a few seconds.",
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

export interface UpdateBannerModel {
  readonly text: string;
  /** What a tap does: open the install permission page, or restart into the update. */
  readonly action: "permission" | "restart";
}

/** The Bots home banner: an update that is ready to restart into, or one blocked on the install permission. */
export function updateBannerModel(snapshot: UpdateSnapshot | null): UpdateBannerModel | null {
  if (snapshot === null || snapshot.target === null) {
    return null;
  }
  if (snapshot.state === "needsPermission") {
    return {
      text: `Update to ${snapshot.target.version} is waiting. Allow hbots to install updates.`,
      action: "permission",
    };
  }
  if (snapshot.state === "ready" || snapshot.state === "needsTap") {
    return { text: `hbots ${snapshot.target.version} is ready.`, action: "restart" };
  }
  return null;
}
