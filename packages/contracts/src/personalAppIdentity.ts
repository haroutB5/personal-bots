/**
 * Who this app is, in the places that have to agree about it.
 *
 * The web sets one document title from `apps/web/src/branding.ts`, its
 * manifest names the installed app, and the desktop guard refuses both
 * because the Bots UI can approve its own cards and change settings. A name
 * change in one place without the others would open that window, so all of
 * them read the values from here.
 *
 * The stage labels are the ones branding can append: "T3 Code (Alpha)" on
 * this build, "(Dev)" in development and "(Nightly)" on that channel. The
 * latest channel has no suffix and is the bare base name.
 */
export const PERSONAL_APP_BASE_NAME = "T3 Code";

/** `name` in `apps/web/public/manifest.webmanifest`. */
export const PERSONAL_APP_MANIFEST_NAME = "Bots";

/** Stage suffixes `apps/web` can put after the base name. */
export const PERSONAL_APP_STAGE_LABELS = ["Alpha", "Dev", "Nightly"] as const;

/** Every document title the web can set, without the browser's own suffix. */
export const personalAppDisplayTitles = (): ReadonlyArray<string> => [
  PERSONAL_APP_BASE_NAME,
  ...PERSONAL_APP_STAGE_LABELS.map((stage) => `${PERSONAL_APP_BASE_NAME} (${stage})`),
];
