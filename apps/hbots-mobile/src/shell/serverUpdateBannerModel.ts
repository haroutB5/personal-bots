export interface BannerLines {
  readonly title: string;
  readonly detail: string | null;
}

/**
 * Names the side that moved when the server and app versions differ. "Its update
 * follows" only when the updater has a newer target: a server-only release ships no APK.
 */
export function finishedNoteForApp<Lines extends BannerLines>(
  lines: Lines,
  input: {
    readonly finished: boolean;
    readonly serverVersion: string | null;
    readonly appVersion: string;
    /** The version the app updater is fetching or holds, if any. */
    readonly appUpdateVersion?: string | null;
  },
): Lines {
  const server = input.serverVersion?.trim() ?? "";
  const app = input.appVersion.trim();
  if (!input.finished || server.length === 0 || app.length === 0 || server === app) return lines;
  const next = input.appUpdateVersion?.trim() ?? "";
  const follows = next.length > 0 && next !== app;
  return {
    ...lines,
    title: `Server updated to ${server}`,
    detail: follows ? `This app is on ${app}. Its update follows.` : `This app is on ${app}.`,
  };
}
