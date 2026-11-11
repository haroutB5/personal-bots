const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

// The Computer live view can shrink to a small window. The attribute goes on the main
// activity only: no other activity (ShareActivity, notification entries) may enter PiP.
// The window changes size when it enters PiP, so the activity must handle those config
// changes itself or Android would recreate it and the live socket would restart.
const MAIN_ACTIVITY = ".MainActivity";
const NEEDED_CONFIG_CHANGES = [
  "screenSize",
  "smallestScreenSize",
  "screenLayout",
  "orientation",
];

function isMainActivity(entry) {
  const name = entry.$["android:name"];
  return name === MAIN_ACTIVITY || name.endsWith(".MainActivity");
}

/** Sets supportsPictureInPicture on MainActivity and merges the config changes it needs. */
function applyPictureInPicture(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const main = (application.activity ?? []).find(isMainActivity);
  if (main === undefined) {
    throw new Error("withPictureInPicture: MainActivity is missing from the manifest.");
  }
  main.$["android:supportsPictureInPicture"] = "true";
  const current = (main.$["android:configChanges"] ?? "").split("|").filter((x) => x !== "");
  for (const flag of NEEDED_CONFIG_CHANGES) {
    if (!current.includes(flag)) current.push(flag);
  }
  main.$["android:configChanges"] = current.join("|");
  return manifest;
}

function withPictureInPicture(config) {
  return withAndroidManifest(config, (next) => {
    next.modResults = applyPictureInPicture(next.modResults);
    return next;
  });
}

module.exports = withPictureInPicture;
module.exports.applyPictureInPicture = applyPictureInPicture;
