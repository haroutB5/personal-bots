/**
 * Android permissions the app asks Expo to strip from its manifest. The overlay permission stays:
 * the updater needs its grant to reopen the app after Restart, and nothing draws an overlay.
 */
export const BLOCKED_PERMISSIONS: ReadonlyArray<string> = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];
