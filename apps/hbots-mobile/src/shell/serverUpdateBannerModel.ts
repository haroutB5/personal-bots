export interface BannerLines {
  readonly title: string;
  readonly detail: string | null;
}

/**
 * The finished note names the server's version. When this app is still on another
 * version, "Updated to x" reads as if the app itself was updated, so the note says
 * which side moved and that the app's own update is still to come.
 */
export function finishedNoteForApp<Lines extends BannerLines>(
  lines: Lines,
  input: {
    readonly finished: boolean;
    readonly serverVersion: string | null;
    readonly appVersion: string;
  },
): Lines {
  const server = input.serverVersion?.trim() ?? "";
  const app = input.appVersion.trim();
  if (!input.finished || server.length === 0 || app.length === 0 || server === app) return lines;
  return {
    ...lines,
    title: `Server updated to ${server}`,
    detail: `This app is on ${app}. Its update follows.`,
  };
}
