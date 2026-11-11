const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

// ShareActivity has no UI and sends nothing: it copies shared content:// streams and
// text into the app cache, then opens the bot picker. Exported because other apps
// start it; taskAffinity "" and excludeFromRecents keep it out of the source app's task.
const ACTIVITY_NAME = "expo.modules.hbotsshare.ShareActivity";
const SHARE_TYPES = ["text/*", "image/*", "application/pdf"];

function filter(actions, mimeTypes, label) {
  return {
    ...(label === undefined ? {} : { $: { "android:label": label } }),
    action: actions.map((name) => ({ $: { "android:name": name } })),
    category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
    data: mimeTypes.map((mimeType) => ({ $: { "android:mimeType": mimeType } })),
  };
}

function shareActivity() {
  return {
    $: {
      "android:name": ACTIVITY_NAME,
      "android:exported": "true",
      "android:excludeFromRecents": "true",
      "android:label": "@string/hbots_share_label",
      "android:launchMode": "standard",
      "android:noHistory": "true",
      "android:taskAffinity": "",
      "android:theme": "@style/Theme.HbotsShare",
    },
    "intent-filter": [
      filter(["android.intent.action.SEND"], SHARE_TYPES),
      filter(["android.intent.action.SEND_MULTIPLE"], SHARE_TYPES),
      filter(["android.intent.action.PROCESS_TEXT"], ["text/plain"], "@string/hbots_ask_label"),
    ],
  };
}

/** Adds ShareActivity to the manifest once. */
function applyShareTarget(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const activities = (application.activity ??= []);
  if (!activities.some((entry) => entry.$["android:name"] === ACTIVITY_NAME)) {
    activities.push(shareActivity());
  }
  return manifest;
}

function withShareTarget(config) {
  return withAndroidManifest(config, (next) => {
    next.modResults = applyShareTarget(next.modResults);
    return next;
  });
}

module.exports = withShareTarget;
module.exports.applyShareTarget = applyShareTarget;
module.exports.ACTIVITY_NAME = ACTIVITY_NAME;
