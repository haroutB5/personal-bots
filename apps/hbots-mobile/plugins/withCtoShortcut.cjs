const NodeFS = require("node:fs");
const NodePath = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withStringsXml,
} = require("expo/config-plugins");

// A static launcher shortcut (long-press the icon) that opens a new chat with the
// CTO bot. It uses the alias link because the bot id is not known at build time;
// the app resolves the alias to the CTO bot when it opens.
const SHORTCUT_LINK = "hbots://bot/cto?new=1";
const SHORTCUT_META = "android.app.shortcuts";
const SHORTCUTS_RESOURCE = "@xml/hbots_shortcuts";
const SHORT_LABEL = "hbots_shortcut_cto_short";
const LONG_LABEL = "hbots_shortcut_cto_long";

function shortcutsXml(packageName) {
  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
    android:shortcutId="new_cto_chat"
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutShortLabel="@string/${SHORT_LABEL}"
    android:shortcutLongLabel="@string/${LONG_LABEL}">
    <intent
      android:action="android.intent.action.VIEW"
      android:data="${SHORTCUT_LINK}"
      android:targetPackage="${packageName}"
      android:targetClass="${packageName}.MainActivity"/>
  </shortcut>
</shortcuts>
`;
}

/** Adds the shortcuts meta-data to the launcher activity once. */
function applyShortcutMeta(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  const meta = (activity["meta-data"] ??= []);
  if (!meta.some((entry) => entry.$["android:name"] === SHORTCUT_META)) {
    meta.push({ $: { "android:name": SHORTCUT_META, "android:resource": SHORTCUTS_RESOURCE } });
  }
  return manifest;
}

function applyStrings(strings) {
  const items = [
    { name: SHORT_LABEL, value: "New CTO chat" },
    { name: LONG_LABEL, value: "New chat with the CTO" },
  ];
  let next = strings;
  for (const item of items) {
    next = AndroidConfig.Strings.setStringItem(
      [{ $: { name: item.name, translatable: "false" }, _: item.value }],
      next,
    );
  }
  return next;
}

function withCtoShortcut(config) {
  const packageName = config.android?.package;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error("withCtoShortcut: android.package is required.");
  }
  config = withAndroidManifest(config, (next) => {
    next.modResults = applyShortcutMeta(next.modResults);
    return next;
  });
  config = withStringsXml(config, (next) => {
    next.modResults = applyStrings(next.modResults);
    return next;
  });
  return withDangerousMod(config, [
    "android",
    async (next) => {
      const dir = NodePath.join(next.modRequest.platformProjectRoot, "app/src/main/res/xml");
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "hbots_shortcuts.xml"), shortcutsXml(packageName));
      return next;
    },
  ]);
}

module.exports = withCtoShortcut;
module.exports.shortcutsXml = shortcutsXml;
module.exports.applyShortcutMeta = applyShortcutMeta;
module.exports.applyStrings = applyStrings;
module.exports.SHORTCUT_LINK = SHORTCUT_LINK;
